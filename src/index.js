import Autobee from 'autobee'
import Hyperbee from 'hyperbee2'
import ProtomuxWakeup from 'protomux-wakeup'
import Corestore from 'corestore'
import CoreStorage from 'hypercore-storage'
import Hyperswarm from 'hyperswarm'
import Hyperblobs from 'hyperblobs'
import hypercoreCrypto from 'hypercore-crypto'
import { createBlobRangeServer } from './blob-server.js'
import b4a from 'b4a'
import { createHash } from 'node:crypto'
import { pipelinePromise, Readable, Transform } from 'streamx'
import { readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { tuneUdxSocket } from './lan.js'
import { createPrivateSwarm } from './private-overlay.js'
import { deriveIdentity, formatAccessUri, generateMnemonic, normalizeMnemonic, unwrapVideoKey, validateMnemonic, verifyClaim, wrapVideoKey } from './mnemonic.js'
const ID = /^[a-z0-9]+:[a-z0-9]+(:s\d{2}e\d{2,3})?$/
const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/
const HEX144 = /^[0-9a-f]{144}$/
const ROLES = new Set(['owner', 'mod', 'writer'])
const MAX_TITLE = 300
const BLOB_BLOCK_SIZE = 512 * 1024
const MAX_CONTENT_TOPICS = 24
// How often content beyond the announcement cap gets its turn on the DHT.
const CONTENT_TOPIC_ROTATE_MS = 20_000
const isUniform512 = blob => Boolean(blob && (
  blob.byteLength === 0 || (
    blob.blockLength > 0 &&
    (blob.blockLength - 1) * BLOB_BLOCK_SIZE < blob.byteLength &&
    blob.byteLength <= blob.blockLength * BLOB_BLOCK_SIZE
  )
))

// Every peer value is untrusted until decodeOp blesses it; typeof guards every regex.
const str = (v, re) => typeof v === 'string' && re.test(v)
const cleanText = (v, fallback = '') => String(v || fallback).slice(0, MAX_TITLE).toWellFormed()
const parseQuery = raw => {
  const out = {}
  if (!raw) return out
  for (const part of raw.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const k = eq === -1 ? part : part.slice(0, eq)
    const v = eq === -1 ? '' : part.slice(eq + 1)
    try { out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')) } catch { out[k] = v }
  }
  return out
}

// Formats a sourceless magnet URI for Master's swarm, tucking in only read-only channel attribution and never leaking a writable tracker key.
export function formatWatchUri (entry, source = '', sourceKind = '') {
  const b = entry.blob || {}
  const q = [`id=${encodeURIComponent(entry.id)}`, `title=${encodeURIComponent(cleanText(entry.title, entry.id))}`]
  if (str(entry.sha256, HEX64)) q.push(`sha256=${entry.sha256}`)
  if (sourceKind === 'channel' && str(source, HEX64)) {
    q.push(`source=${source}`, 'kind=channel')
  }
  return `peartube://watch/${entry.blobs}:${b.blockOffset}:${b.blockLength}:${b.byteOffset}:${b.byteLength}?${q.join('&')}`
}

// Strips peartube:// links and raw 64-hex keys down to an actionable channel, subscriber access pass, or instant watch payload.
export function parseUri (input, defaultKind = 'channel') {
  if (typeof input !== 'string') throw new Error('URI or 64-hex key required')
  const raw = input.trim()
  const lower = raw.toLowerCase()
  if (HEX64.test(lower)) return { action: 'source', key: lower, kind: defaultKind === 'tracker' ? 'channel' : 'channel', alias: '' }
  const m = raw.match(/^peartube:(?:\/\/)?([a-z]+)\/([^?#]+)(?:\?([^#]*))?/i)
  if (!m) throw new Error('Invalid PearTube URI or 64-hex key')
  const verb = m[1].toLowerCase()
  const body = m[2].trim()
  const q = parseQuery(m[3] || '')
  if (verb === 'channel' || verb === 'tracker' || verb === 'add' || verb === 'source') {
    const key = body.toLowerCase()
    if (!HEX64.test(key)) throw new Error('Channel key must be 64 hex characters')
    return { action: 'source', key, kind: 'channel', alias: cleanText(q.name || q.alias || '') }
  }
  if (verb === 'access') {
    const parts = body.split(':')
    if (parts.length !== 3 || !HEX64.test(parts[0].toLowerCase()) || !HEX64.test(parts[2].toLowerCase())) {
      throw new Error('Malformed peartube://access pass')
    }
    const epoch = Number(parts[1])
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('Malformed peartube://access epoch')
    return {
      action: 'access',
      channel: parts[0].toLowerCase(),
      epoch,
      epochKey: parts[2].toLowerCase(),
      alias: cleanText(q.name || q.alias || '')
    }
  }
  if (verb === 'watch') {
    const parts = body.split(':')
    if (parts.length !== 5 || !HEX64.test(parts[0].toLowerCase())) throw new Error('Malformed peartube://watch blob pointer')
    const blobs = parts[0].toLowerCase()
    const [blockOffset, blockLength, byteOffset, byteLength] = parts.slice(1).map(Number)
    if (![blockOffset, blockLength, byteOffset, byteLength].every(n => Number.isSafeInteger(n) && n >= 0) || blockLength <= 0) {
      throw new Error('Malformed peartube://watch block bounds')
    }
    const sha256 = q.sha256 && HEX64.test(q.sha256.toLowerCase()) ? q.sha256.toLowerCase() : ('0'.repeat(64))
    const fallbackId = `clip:${(q.sha256 || blobs).toLowerCase().slice(0, 12)}`
    const id = str(q.id?.toLowerCase(), ID) ? q.id.toLowerCase() : fallbackId
    const title = cleanText(q.title, id)
    const sourceKey = q.kind !== 'tracker' && q.source && HEX64.test(q.source.toLowerCase()) ? q.source.toLowerCase() : null
    return {
      action: 'watch',
      sourceKey,
      sourceKind: 'channel',
      entry: { type: 'announce', id, title, size: byteLength, sha256, blobs, blob: { blockOffset, blockLength, byteOffset, byteLength } }
    }
  }
  throw new Error(`Unsupported PearTube URI action: ${verb}`)
}

export function decodeOp (value) {
  let op
  try { op = JSON.parse(typeof value === 'string' ? value : b4a.toString(value)) } catch { return null }
  if (op === null || typeof op !== 'object') return null
  if (op.claim !== undefined && !str(op.claim, HEX128)) return null
  if (op.type === 'init') {
    if (op.owner !== undefined && !str(op.owner, HEX64)) return null
    if (op.epoch !== undefined && (!Number.isSafeInteger(op.epoch) || op.epoch < 1)) return null
    return op
  }
  if (op.type === 'owner') return str(op.owner, HEX64) ? op : null
  if (op.type === 'epoch') return Number.isSafeInteger(op.epoch) && op.epoch >= 1 ? op : null
  if (op.type === 'claim') return str(op.sig, HEX128) ? op : null
  if (op.type === 'grant') return str(op.writer, HEX64) && ROLES.has(op.role || 'writer') ? op : null
  if (op.type === 'revoke') return str(op.writer, HEX64) ? op : null
  if (op.type === 'remove') return typeof op.key === 'string' ? op : null
  if (op.type === 'peer') return str(op.publicKey, HEX64) && Number.isSafeInteger(op.expiresAt) && op.expiresAt > 0 ? op : null
  if (op.type === 'source') {
    if (!str(op.sourceKey, HEX64) || (op.kind !== 'tracker' && op.kind !== 'channel')) return null
    if (typeof op.title !== 'string' || op.title.length === 0 || op.title.length > MAX_TITLE) return null
    return op
  }
  if (op.type !== 'announce' || !str(op.id, ID) || !str(op.blobs, HEX64) || !str(op.sha256, HEX64)) return null
  if (typeof op.title !== 'string' || op.title.length > MAX_TITLE || !Number.isSafeInteger(op.size) || op.size < 0) return null
  if (op.epoch !== undefined && (!Number.isSafeInteger(op.epoch) || op.epoch < 1)) return null
  if (op.wrappedKey !== undefined && !str(op.wrappedKey, HEX144)) return null
  const { blockOffset, blockLength, byteOffset, byteLength } = op.blob || {}
  if (![blockOffset, blockLength, byteOffset, byteLength].every(n => Number.isSafeInteger(n) && n >= 0)) return null
  return op
}

const isSystemViewKey = k => k.startsWith('peer/') || k.startsWith('source/') || k.startsWith('meta/') || k.startsWith('writer/') || k.startsWith('revoked/')

// Deterministic ACL gate at the mouth of every unified Channel: ungranted strangers get swallowed and ignored,
// linked devices prove ownership via detached 12-word vault claims or owner grants, and owners/mods can purge any key.
function makeApply (getChannelHex, onWriterChange = null) {
  return async function apply (nodes, view, host) {
    const chHex = getChannelHex()
    const roles = new Map()
    const revokedCache = new Map()
    let ownerHex = null
    let curEpoch = null
    const ops = []
    async function flushOps () {
      if (!ops.length) return
      const w = view.write()
      for (const [kind, k, v] of ops) {
        if (kind === 'put') w.tryPut(k, v)
        else w.tryDelete(k)
      }
      ops.length = 0
      await w.flush()
    }
    async function getOwner () {
      if (ownerHex !== null) return ownerHex
      const n = await view.get(b4a.from('meta/owner'))
      ownerHex = n ? b4a.toString(n.value) : ''
      return ownerHex
    }
    async function isRevoked (wHex) {
      if (revokedCache.has(wHex)) return revokedCache.get(wHex)
      const r = Boolean(await view.get(b4a.from(`revoked/${wHex}`)))
      revokedCache.set(wHex, r)
      return r
    }
    for (const node of nodes) {
      const op = decodeOp(node.value)
      if (!op) continue
      if (op.type === 'peer' && !(await getOwner())) continue
      const writer = b4a.toString(node.key, 'hex')
      let role = writer === chHex ? 'owner' : (roles.get(writer) ?? null)
      let claimedHere = false
      let legacyGrantedHere = false
      if (!role && !roles.has(writer)) {
        const rec = await view.get(b4a.from(`writer/${writer}`))
        if (rec) {
          try { role = JSON.parse(b4a.toString(rec.value))?.role || null } catch {}
        }
        if (role) roles.set(writer, role)
      }
      if (!role) {
        const curOwner = await getOwner()
        const claimSig = op.type === 'claim' ? op.sig : op.claim
        if (claimSig && curOwner) {
          if (!(await isRevoked(writer)) && verifyClaim(chHex, writer, curOwner, claimSig)) {
            await host.addWriter(node.key, { isIndexer: false })
            role = 'owner'
            roles.set(writer, role)
            claimedHere = true
            onWriterChange?.(writer, true)
          }
        } else if (!curOwner) {
          await host.addWriter(node.key, { isIndexer: false })
          role = 'writer'
          roles.set(writer, role)
          legacyGrantedHere = true
          onWriterChange?.(writer, true)
        } else {
          roles.set(writer, '')
        }
      }
      if (!role) continue
      if (claimedHere) {
        ops.push(['put', b4a.from(`writer/${writer}`), b4a.from(JSON.stringify({ role: 'owner', alias: cleanText(op.alias || '') }))])
        if (op.type === 'claim') continue
      } else if (legacyGrantedHere) {
        ops.push(['put', b4a.from(`writer/${writer}`), b4a.from(JSON.stringify({ role: 'writer', alias: '' }))])
      }
      if (op.type === 'init') {
        if (writer === chHex) {
          roles.set(writer, 'owner')
          ops.push(['put', b4a.from(`writer/${writer}`), b4a.from(JSON.stringify({ role: 'owner', alias: 'primary' }))])
          if (op.owner) {
            ownerHex = op.owner
            ops.push(['put', b4a.from('meta/owner'), b4a.from(op.owner)])
          }
          if (op.epoch) {
            curEpoch = op.epoch
            ops.push(['put', b4a.from('meta/epoch'), b4a.from(String(op.epoch))])
          }
        }
      } else if (op.type === 'owner') {
        if (role === 'owner' && !(await getOwner())) {
          ownerHex = op.owner
          ops.push(['put', b4a.from('meta/owner'), b4a.from(op.owner)])
        }
      } else if (op.type === 'epoch') {
        if (role === 'owner') {
          if (curEpoch === null) curEpoch = Number(b4a.toString((await view.get(b4a.from('meta/epoch')))?.value || '1')) || 1
          if (op.epoch > curEpoch) {
            curEpoch = op.epoch
            ops.push(['put', b4a.from('meta/epoch'), b4a.from(String(op.epoch))])
          }
        }
      } else if (op.type === 'grant') {
        if (role === 'owner') {
          const nextRole = op.role || 'writer'
          revokedCache.set(op.writer, false)
          roles.set(op.writer, nextRole)
          ops.push(['del', b4a.from(`revoked/${op.writer}`)])
          await host.addWriter(b4a.from(op.writer, 'hex'), { isIndexer: false })
          ops.push(['put', b4a.from(`writer/${op.writer}`), b4a.from(JSON.stringify({ role: nextRole, alias: cleanText(op.alias || '') }))])
          onWriterChange?.(op.writer, true)
        }
      } else if (op.type === 'revoke') {
        if (role === 'owner' && op.writer !== chHex) {
          await host.removeWriter(b4a.from(op.writer, 'hex'))
          roles.set(op.writer, '')
          revokedCache.set(op.writer, true)
          ops.push(['del', b4a.from(`writer/${op.writer}`)])
          ops.push(['put', b4a.from(`revoked/${op.writer}`), b4a.from('1')])
          onWriterChange?.(op.writer, false)
          if (op.purgeEntries) {
            await flushOps()
            for await (const entry of view.createReadStream()) {
              const ek = b4a.toString(entry.key)
              if (ek === `peer/${op.writer}` || ek.startsWith(`source/${op.writer}/`) || (!isSystemViewKey(ek) && ek.split('/')[1] === op.writer)) {
                ops.push(['del', entry.key])
              }
            }
          }
        }
      } else if (op.type === 'remove') {
        if (!op.key.startsWith('meta/') && !op.key.startsWith('writer/') && !op.key.startsWith('revoked/')) {
          if (role === 'owner' || role === 'mod' || op.key.split('/')[1] === writer) {
            ops.push(['del', b4a.from(op.key)])
          }
        }
      } else if (op.type === 'peer') {
        ops.push(['put', b4a.from(`peer/${writer}`), node.value])
      } else if (op.type === 'source') {
        ops.push(['put', b4a.from(`source/${writer}/${op.sourceKey}`), node.value])
      } else if (op.type === 'announce') {
        ops.push(['put', b4a.from(`${op.id}/${writer}/${op.blobs}:${op.blob.blockOffset}`), node.value])
      }
    }
    await flushOps()
  }
}
// Reads take a tracker's view as far as Autobee has applied it, waiting at most a second for more. A fresh
// joiner of a large tracker takes minutes to catch up (V8 on a Mac: about two; a phone's QuickJS: far longer),
// and starting, listing and playback must not wait that out: the list fills in as it applies, and Autobee's
// update events redraw it. Writes and garbage collection still wait for the whole update.
function applied (bee) {
  const update = bee.update()
  update.catch(() => {})
  let timer
  const wait = new Promise(resolve => { timer = setTimeout(resolve, 1000) })
  return Promise.race([update, wait]).finally(() => clearTimeout(timer))
}

// A node that fails partway through opening closes what it opened, so the same storage can be opened again.
export async function createNode (opts) {
  const undo = []
  try {
    return await openNode(opts, undo)
  } catch (err) {
    for (const fn of undo.reverse()) {
      try { await fn() } catch {}
    }
    throw err
  }
}

async function openNode ({
  storage,
  channel: channelOpt = null,
  tracker: trackerOpt = null,
  mnemonic: mnemonicOpt = null,
  join: joinOpt = false,
  sources: initialSources = [],
  allowedPeers = null,
  streamHost = '127.0.0.1',
  streamPort = 0,
  bootstrap,
  privateHost = null,
  dhtPort,
  privateRouting = false,
  privateRelay = false,
  relayThrough = null,
  lan: createLan = null,
  // Set by the apps' worklet (worklet/worker.js): small request windows for phones' UDP buffers.
  maxActiveSources = null,
  worklet: isWorklet = false,
  onchange = null
}, undo) {
  if (privateRelay) {
    throw new Error('Embedded privateRelay was removed; run standalone peartube-private-relay (bin/private-relay.js) so guard forwarders never open Corestore or tracker state')
  }
  const csDir = join(storage, 'corestore')
  // The node owns its hypercore-storage so compaction and core lookups go through that instance, not Corestore internals.
  // Choke client worklet RocksDB caches and open SST readers tight so 50 GB libraries ride OS page cache dry-free instead of bloating app RAM while Master's cock waits.
  const isMobileWorklet = isWorklet && os.platform() !== 'darwin'
  const storageOpts = isWorklet
    ? {
        writeBufferSize: isMobileWorklet ? 12 * 1024 * 1024 : 32 * 1024 * 1024,
        maxOpenFiles: 48,
        maxBackgroundJobs: isMobileWorklet ? 3 : 4,
        maxFileOpeningThreads: 2,
        blockCache: false,
        tableCacheIndexAndFilterBlocks: false,
        topLevelIndexPinningTier: 0,
        partitionPinningTier: 0,
        unpartitionedPinningTier: 0,
        optimizeFiltersForMemory: true,
        treeCache: { maxSize: 512 }
      }
    : undefined
  let coreStorage = new CoreStorage(csDir, storageOpts)
  let store = new Corestore(coreStorage)
  try {
    await store.ready()
  } catch (err) {
    if (!/Invalid device file/i.test(err?.message || '')) throw err
    await store.close().catch(() => {})
    try { unlinkSync(join(csDir, 'CORESTORE')) } catch {}
    coreStorage = new CoreStorage(csDir, storageOpts)
    store = new Corestore(coreStorage)
    await store.ready()
  }
  undo.push(() => store.close())
  const storedDisc = new Set()
  for await (const raw of coreStorage.createCoreStream()) {
    if (raw?.discoveryKey) storedDisc.add(b4a.toString(raw.discoveryKey, 'hex'))
  }
  const wakeup = new ProtomuxWakeup()
  let onPeersChanged = null
  let viewEpoch = 1
  const update = () => {
    viewEpoch++
    if (onchange) queueMicrotask(onchange)
    if (onPeersChanged) queueMicrotask(onPeersChanged)
  }
  // Private 0600 vault file beside settings.json/jobs.json: holds the 12-word recovery phrase and subscriber epoch passes, never in Corestore.
  const identityFile = join(storage, 'identity.json')
  let savedIdentity = {}
  try { savedIdentity = JSON.parse(readFileSync(identityFile, 'utf8')) || {} } catch {}
  const accessKeys = new Map()
  for (const [k, v] of Object.entries(savedIdentity.accessKeys || {})) {
    if (typeof v === 'string' && HEX64.test(v.toLowerCase())) accessKeys.set(k.toLowerCase(), v.toLowerCase())
  }
  let currentMnemonic = mnemonicOpt ? normalizeMnemonic(mnemonicOpt) : (savedIdentity.mnemonic ? normalizeMnemonic(savedIdentity.mnemonic) : '')
  if (currentMnemonic && !validateMnemonic(currentMnemonic)) {
    if (mnemonicOpt) throw new Error('Invalid 12- or 24-word recovery phrase')
    currentMnemonic = ''
  }
  let idVault = currentMnemonic ? deriveIdentity(currentMnemonic) : null
  let foundedKey = typeof savedIdentity.founded === 'string' && HEX64.test(savedIdentity.founded) ? savedIdentity.founded : ''
  function saveIdentity () {
    try {
      const payload = {
        mnemonic: currentMnemonic || '',
        founded: foundedKey || '',
        accessKeys: Object.fromEntries(accessKeys)
      }
      writeFileSync(identityFile + '.tmp', JSON.stringify(payload, null, 2), { mode: 0o600 })
      renameSync(identityFile + '.tmp', identityFile)
    } catch {}
  }

  let targetKey = String(channelOpt || trackerOpt || '').trim().toLowerCase() || null
  if (targetKey && !HEX64.test(targetKey)) throw new Error('Channel key must be 64 hex characters')
  if (joinOpt && idVault && !targetKey) targetKey = idVault.channelKey

  const chNs = store.namespace('tracker')
  const probeLocal = chNs.get({ name: 'local', active: false })
  await probeLocal.ready()
  const hasPreMnemonicLocal = probeLocal.length > 0
  await probeLocal.close()

  let founderKeyPair = null
  if (!targetKey) {
    if (hasPreMnemonicLocal && !foundedKey) {
      if (!idVault) {
        currentMnemonic = generateMnemonic(12)
        idVault = deriveIdentity(currentMnemonic)
      }
    } else {
      if (!idVault) {
        currentMnemonic = generateMnemonic(12)
        idVault = deriveIdentity(currentMnemonic)
      }
      if (foundedKey && foundedKey !== idVault.channelKey) {
        targetKey = idVault.channelKey
      } else {
        founderKeyPair = idVault.genesisKeyPair
      }
    }
  } else if (!idVault && !joinOpt) {
    currentMnemonic = generateMnemonic(12)
    idVault = deriveIdentity(currentMnemonic)
  }

  const secondaryWriters = new Set()
  const writerCores = new Map()
  let channel = null
  const onWriterChange = (wHex, added) => {
    if (!channel || wHex === b4a.toString(channel.key, 'hex')) return
    if (added) secondaryWriters.add(wHex)
    else secondaryWriters.delete(wHex)
  }
  const primaryApply = makeApply(() => b4a.toString(channel.key, 'hex'), onWriterChange)
  // fastForward: false forces every peer to verify ACL grants, claims, and removals locally through apply.
  let primaryDirty = true
  let primaryHydrated = false
  const primaryCache = { entries: [], byId: new Map(), discovered: [], peers: [] }
  channel = new Autobee(chNs, targetKey ? b4a.from(targetKey, 'hex') : null, {
    ...(founderKeyPair ? { keyPair: founderKeyPair } : {}),
    apply: primaryApply,
    update: () => { primaryDirty = true; update() },
    optimistic: true,
    fastForward: false,
    wakeup
  })
  undo.push(() => channel.close())
  await channel.ready()

  let inflightRange = isMobileWorklet ? [6, 8] : (isWorklet ? [16, 48] : [12, 32])
  const primaryKey = b4a.toString(channel.key, 'hex')
  let usePrimaryChannel = Boolean(targetKey) || initialSources.length === 0
  let channelHasEntries = false
  if (channel.bootstrap.writable && !foundedKey) foundedKey = primaryKey
  saveIdentity()

  if (!targetKey && channel.local.length === 0 && channel.bootstrap.writable) {
    await channel.append(b4a.from(JSON.stringify({ type: 'init', owner: idVault?.ownerPublicKey || undefined, epoch: 1 })))
    await channel.updated()
    primaryDirty = true
  }

  async function syncWriterCores () {
    for (const [hex, c] of writerCores) {
      if (!secondaryWriters.has(hex)) {
        writerCores.delete(hex)
        await c.close().catch(() => {})
      }
    }
    for (const hex of secondaryWriters) {
      if (writerCores.has(hex)) continue
      const c = store.get({ key: b4a.from(hex, 'hex'), active: false })
      writerCores.set(hex, c)
      await c.ready().catch(() => {})
    }
  }

  // Legacy shared slots stay readable & migratable in place; every new video gets its own 512 KiB-piece Hypercore closed at rest.
  const blobSlots = []
  const blobCores = new Map()
  const ownedBlobs = new Map() // blobsHex -> { length, byteLength }
  const ownedByDiscovery = new Map() // discoveryKeyHex -> blobsHex
  const cachedBlobs = new Map() // blobsHex -> { length, byteLength, blocks, slices }
  const cachedByDiscovery = new Map() // discoveryKeyHex -> blobsHex
  const encryptedBlobs = new Map() // blobsHex -> { source, epoch, wrappedKey }
  const unlockedVideoKeys = new Map() // blobsHex -> Buffer(32)
  const registerOwned = (hex, meta) => {
    ownedBlobs.set(hex, meta)
    ownedByDiscovery.set(b4a.toString(hypercoreCrypto.discoveryKey(b4a.from(hex, 'hex')), 'hex'), hex)
  }
  function resolveVideoKey (entry, sourceHex) {
    if (!entry?.wrappedKey) return null
    encryptedBlobs.set(entry.blobs, { source: sourceHex, epoch: entry.epoch || 1, wrappedKey: entry.wrappedKey })
    const cached = unlockedVideoKeys.get(entry.blobs)
    if (cached) return cached
    const ep = entry.epoch || 1
    const candidates = []
    if (idVault) {
      candidates.push(idVault.epochKey(sourceHex, ep))
    }
    const passHex = accessKeys.get(`${sourceHex}:${ep}`)
    if (passHex) candidates.push(b4a.from(passHex, 'hex'))
    for (const ek of candidates) {
      const vk = unwrapVideoKey(entry.wrappedKey, ek)
      if (vk) {
        unlockedVideoKeys.set(entry.blobs, vk)
        return vk
      }
    }
    return null
  }
  function resolveBlobEncryptionKey (hex) {
    const cached = unlockedVideoKeys.get(hex)
    if (cached) return cached
    const meta = encryptedBlobs.get(hex)
    if (!meta) return null
    return resolveVideoKey({ blobs: hex, epoch: meta.epoch, wrappedKey: meta.wrappedKey }, meta.source)
  }
  async function openSlot (i) {
    const core = store.get({ name: i === 0 ? 'blobs' : `blobs-${i}` })
    await core.ready()
    const slot = { core, blobs: new Hyperblobs(core, { blockSize: BLOB_BLOCK_SIZE }), key: b4a.toString(core.key, 'hex') }
    blobSlots.push(slot)
    blobCores.set(slot.key, core)
    return slot
  }
  await openSlot(0)
  for (let i = 1; i < 64; i++) {
    const core = store.get({ name: `blobs-${i}` })
    await core.ready()
    if (core.length === 0) { await core.close(); if (i >= 4) break; else continue }
    const slot = { core, blobs: new Hyperblobs(core, { blockSize: BLOB_BLOCK_SIZE }), key: b4a.toString(core.key, 'hex') }
    blobSlots.push(slot)
    blobCores.set(slot.key, core)
  }
  const slotSet = new Set(blobSlots.map(s => s.key))
  const isOwnedBlob = hex => ownedBlobs.has(hex) || slotSet.has(hex)
  const blobsKey = blobSlots[0].key

  async function hydrateOwned () {
    const candidates = new Set()
    const writer = b4a.toString(channel.local.key, 'hex')
    for await (const n of channel.view.createReadStream()) {
      const k = b4a.toString(n.key)
      if (k.startsWith('writer/')) {
        const wHex = k.slice(7)
        if (wHex !== primaryKey) secondaryWriters.add(wHex)
        continue
      }
      if (k.startsWith('source/')) {
        channelHasEntries = true
        continue
      }
      if (isSystemViewKey(k)) continue
      channelHasEntries = true
      const op = decodeOp(n.value)
      if (!op || op.type !== 'announce') continue
      if (op.wrappedKey) resolveVideoKey(op, primaryKey)
      if (k.split('/')[1] === writer && !slotSet.has(op.blobs)) candidates.add(op.blobs)
    }
    await syncWriterCores()
    const keys = [...candidates].filter(hex => !ownedBlobs.has(hex))
    for (let i = 0; i < keys.length; i += 32) {
      await Promise.all(keys.slice(i, i + 32).map(async hex => {
        const c = store.get({ key: b4a.from(hex, 'hex') })
        try {
          await c.ready()
          if (c.writable && c.length > 0) {
            registerOwned(hex, { length: c.length, byteLength: c.byteLength })
          }
        } finally {
          await c.close().catch(() => {})
        }
      }))
    }
  }
  if (usePrimaryChannel) await (isWorklet ? applied(channel) : channel.update())
  if (channel.writable && idVault && foundedKey === primaryKey && !(await channel.view.get(b4a.from('meta/owner')))) {
    await channel.append(b4a.from(JSON.stringify({ type: 'owner', owner: idVault.ownerPublicKey })))
    await channel.updated()
  }
  await hydrateOwned()
  const host = privateHost ?? (Array.isArray(bootstrap) && bootstrap.some(b => String(b?.host || b).startsWith('127.')) ? '127.0.0.1' : undefined)
  const isPrivate = Boolean(privateRouting)
  const privateOpts = typeof privateRouting === 'object' && privateRouting !== null ? privateRouting : {}
  let closing = false

  let allowedSet = Array.isArray(allowedPeers) && allowedPeers.length ? new Set(allowedPeers.map(k => String(k).toLowerCase())) : null
  const lanPeers = new Set()
  const hasLanPeer = keyBuf => Boolean(keyBuf && [...lanPeers].some(c => !c.destroyed && c.remotePublicKey && b4a.equals(c.remotePublicKey, keyBuf)))
  const firewall = remotePublicKey => (allowedSet ? !allowedSet.has(b4a.toString(remotePublicKey, 'hex')) : false) || hasLanPeer(remotePublicKey)
  const bucket = () => ({ closedRx: 0, closedTx: 0, prevRx: 0, prevTx: 0, downBps: 0, upBps: 0 })
  const traffic = { private: bucket(), public: bucket(), lan: bucket() }
  let prevRx = 0, prevTx = 0, prevAt = Date.now(), downBps = 0, upBps = 0
  const tuneDht = inst => inst?.ready?.().then(() => { tuneUdxSocket(inst.io?.serverSocket); tuneUdxSocket(inst.io?.clientSocket) }).catch(() => {})
  // Every replication connection, public swarm and LAN alike, for plugins that act per peer.
  const peerConns = new Set()
  const connListeners = new Set()
  // A followed channel is an Autobee of its own, and Autobee's wakeup rides its replication stream:
  // a peer that never gets one is never told which writer cores to fetch, so a follower stalls at
  // whatever head it happened to wake with. `Hypercore.createProtocolStream` reuses the connection's
  // existing Protomux, so sharing a connection here is safe.
  function attachSource (src, conn) {
    if (!src?.bee || !src.conns) return
    if (src.conns.has(conn)) return
    src.conns.add(conn)
    try { src.bee.replicate(conn) } catch {}
  }
  const trackConn = (conn, path) => {
    tuneUdxSocket(conn.rawStream?.socket)
    tuneUdxSocket(conn.rawStream?.rawStream?.socket)
    peerConns.add(conn)
    conn.once('close', () => {
      peerConns.delete(conn)
      path.closedRx += conn.rawBytesRead || conn.rawStream?.bytesReceived || 0
      path.closedTx += conn.rawBytesWritten || conn.rawStream?.bytesTransmitted || 0
    })
    channel.replicate(conn)
    for (const s of extraSources.values()) attachSource(s, conn)
    for (const fn of connListeners) fn(conn)
  }
  const swarm = isPrivate
    ? await createPrivateSwarm({
        host,
        bootstrap,
        port: dhtPort || [0, 0],
        allowLoopback: privateOpts.allowLoopback,
        resolveAddress: privateOpts.resolveAddress,
        firewall
      })
    : new Hyperswarm({
        maxParallel: 16,
        bootstrap,
        port: dhtPort || [0, 0],
        firewall,
        relayThrough: relayThrough && (force => force ? relayThrough.map(k => b4a.from(k, 'hex')) : null)
      })
  const dht = isPrivate ? swarm.dht : null
  if (!isPrivate) tuneDht(swarm.dht)
  swarm.on('connection', conn => {
    if (hasLanPeer(conn.remotePublicKey)) { conn.destroy(); return }
    trackConn(conn, dht ? traffic.private : traffic.public)
    if (dht) { channel.update().catch(() => {}); scanPeers().catch(() => {}) }
  })
  undo.push(() => swarm.destroy({ force: true }))
  undo.push(() => {
    closing = true
    wakeup.destroy()
  })
  const discoveries = new Map()
  const lanTopics = new Map()
  // lanPeers declared above so swarm firewall yields to direct LAN sockets
  let lan = null

  function joinOverlayTopic (id, keyBuf, discKey) {
    if (discoveries.has(id)) return
    if (dht) {
      discoveries.set(id, swarm.joinSource(id, keyBuf))
      return
    }
    const disc = swarm.join(discKey, { server: true, client: true })
    discoveries.set(id, disc)
    lanTopics.set(id, discKey)
    lan?.join(discKey)
  }

  async function leaveOverlayTopic (id) {
    const disc = discoveries.get(id)
    const discKey = lanTopics.get(id)
    discoveries.delete(id)
    lanTopics.delete(id)
    if (discKey) lan?.leave?.(discKey)
    if (dht) await swarm.leaveSource(id).catch(() => {})
    else if (disc) await swarm.leave(disc.topic).catch(() => {})
  }

  if (usePrimaryChannel) joinOverlayTopic(`channel:${primaryKey}`, channel.key, channel.discoveryKey)

  // Spreads both PearTube's merged blob topic and stock Hypercore discoveryKey wide on public swarms so supplemental HiveRelays find every wet 512 KiB block.
  const contentTopics = new Map()
  function joinContentSwarm (blobsHex, evict = true) {
    if (dht || closing || !str(blobsHex, HEX64)) return
    // Re-joining an announced topic only refreshes its place in line: the eviction order is the
    // serving order, so a title being played is the last one dropped.
    if (contentTopics.has(blobsHex)) {
      const live = contentTopics.get(blobsHex)
      contentTopics.delete(blobsHex)
      contentTopics.set(blobsHex, live)
      return
    }
    if (contentTopics.size >= MAX_CONTENT_TOPICS) {
      // Catalog reads never displace a topic just because a refresh saw a cached copy. Deliberate
      // joins still rotate the least recently served title out, owned or not: a finished download
      // walks the same queue, so a large library still gets its turn.
      if (!evict) return
      const victim = contentTopics.keys().next().value
      const oldTopics = contentTopics.get(victim)
      contentTopics.delete(victim)
      for (const t of oldTopics) {
        swarm.leave(t).catch(() => {})
        lan?.leave?.(t)
      }
    }
    const keyBuf = b4a.from(blobsHex, 'hex')
    const topics = [
      createHash('sha256').update('peartube/blob/v1/').update(keyBuf).digest(),
      hypercoreCrypto.discoveryKey(keyBuf)
    ]
    contentTopics.set(blobsHex, topics)
    for (const t of topics) {
      swarm.join(t, { server: true, client: true })
      lan?.join(t)
    }
  }
  for (const s of blobSlots) {
    if (s.core.length > 0 && await s.core.count(0, s.core.length) > 0) joinContentSwarm(s.key)
  }
  for (const hex of ownedBlobs.keys()) {
    if (contentTopics.size >= MAX_CONTENT_TOPICS) break
    joinContentSwarm(hex)
  }
  // Content past the cap gets its turn slowly, one complete copy at a time. The status poll used to
  // join every cached core it walked, which churned the DHT and evicted whatever it happened to see.
  const rotateTimer = setInterval(() => {
    if (closing) return
    const candidates = []
    for (const [hex, core] of blobCores) {
      if (contentTopics.has(hex) || isOwnedBlob(hex) || !core.opened || core.length === 0) continue
      ensureBlockCounter(core, hex)
      if (localBlocks(core) >= core.length) candidates.push(hex)
    }
    for (const [hex, meta] of cachedBlobs) {
      if (!contentTopics.has(hex) && !blobCores.has(hex) && !isOwnedBlob(hex) && meta.length > 0 && meta.blocks >= meta.length) {
        candidates.push(hex)
      }
    }
    for (const hex of ownedBlobs.keys()) if (!contentTopics.has(hex)) candidates.push(hex)
    if (candidates.length > 0) joinContentSwarm(candidates[0])
  }, CONTENT_TOPIC_ROTATE_MS)
  rotateTimer.unref?.()
  undo.push(() => clearInterval(rotateTimer))
  if (usePrimaryChannel) channel.update().then(() => closing ? null : hydrateOwned()).catch(() => {})
  function leaveContentSwarm (blobsHex) {
    const oldTopics = contentTopics.get(blobsHex)
    if (!oldTopics) return
    contentTopics.delete(blobsHex)
    for (const t of oldTopics) {
      swarm.leave(t).catch(() => {})
      lan?.leave?.(t)
    }
  }

  // O(1) active channel pool: even with 1,000+ followed channels, keep at most `activeSourceCap` Autobees
  // and overlay topics open in RAM while hibernated channels serve instant cached views and rotate smoothly.
  const activeSourceCap = Math.max(1, Number(maxActiveSources) || (isWorklet ? 8 : 24))
  const extraSources = new Map()
  const activeSources = new Set()
  const ephemeralWatches = new Map()
  let primaryAlias = ''
  let touchClock = 0

  const catalogCacheFile = join(storage, 'catalog-cache.json')
  let savedCatalog = {}
  try { savedCatalog = JSON.parse(readFileSync(catalogCacheFile, 'utf8'))?.channels || {} } catch {}
  let catalogSaveTimer = null
  let catalogCacheDirty = false

  function flushCatalogCache () {
    if (catalogSaveTimer) { clearTimeout(catalogSaveTimer); catalogSaveTimer = null }
    if (!catalogCacheDirty) return
    catalogCacheDirty = false
    try {
      const channels = {}
      for (const [k, s] of extraSources) {
        if (!s.hydrated) continue
        channels[k] = {
          syncedAt: s.syncedAt || 0,
          entries: s.entries.map(it => [it.sub, it.entry]),
          discovered: s.discovered,
          peers: s.peers
        }
      }
      const tmp = `${catalogCacheFile}.tmp.${process.pid}`
      writeFileSync(tmp, JSON.stringify({ version: 1, channels }), { mode: 0o600 })
      renameSync(tmp, catalogCacheFile)
    } catch {}
  }

  function scheduleCatalogSave () {
    catalogCacheDirty = true
    if (closing || catalogSaveTimer) return
    catalogSaveTimer = setTimeout(flushCatalogCache, 5_000)
    catalogSaveTimer.unref?.()
  }

  let lastSwarmFlushAt = 0

  function indexChannelRecords (target, entriesList, discoveredList, peersList, { merge = false } = {}) {
    // A view can be read while it is still catching up, and a follower's scan then holds fewer
    // announces than the library already knows. Replacing wholesale let one partial read wipe the
    // catalog down to a single title; merging keeps what was already proven and adds what is new.
    const byId = merge ? new Map(target.byId) : new Map()
    const bySub = merge ? new Map(target.bySub) : new Map()
    const entries = merge ? new Map(target.entries.map(it => [it.sub, it])) : new Map()
    for (const item of entriesList) {
      if (!bySub.has(item.sub)) {
        let bucket = byId.get(item.entry.id)
        if (!bucket) { bucket = []; byId.set(item.entry.id, bucket) }
        bucket.push(item)
      }
      bySub.set(item.sub, item.entry)
      entries.set(item.sub, item)
    }
    target.entries = [...entries.values()]
    target.byId = byId
    target.bySub = bySub
    target.discovered = discoveredList
    target.peers = peersList
  }

  async function scanChannelView (view, viaKey) {
    const entriesList = []
    const discoveredList = []
    const peersList = []
    for await (const node of view.createReadStream()) {
      const sub = b4a.toString(node.key)
      if (sub.startsWith('source/')) {
        const op = decodeOp(node.value)
        if (op?.type === 'source') {
          discoveredList.push({ key: op.sourceKey, kind: 'channel', title: cleanText(op.title, op.sourceKey.slice(0, 12)), via: viaKey })
        }
      } else if (sub.startsWith('peer/')) {
        const op = decodeOp(node.value)
        if (op?.type === 'peer') peersList.push({ publicKey: op.publicKey, expiresAt: op.expiresAt })
      } else if (!isSystemViewKey(sub)) {
        const op = decodeOp(node.value)
        if (op?.type === 'announce') entriesList.push({ sub, entry: op })
      }
    }
    return { entriesList, discoveredList, peersList }
  }

  async function refreshPrimaryCache ({ force = false } = {}) {
    if (closing) return
    // The node's own channel is read on every call, exactly as before the pool. Caching this one
    // broke co-writer visibility: Autobee only interrupts for its own updates, so a peer's publish
    // could land with `dirty` still false and nothing would rescan — the owner waited out the whole
    // 120 s window in test/network.test.js and never saw the entry. The pool exists for thousands of
    // *followed* channels; this one is one channel, and correctness wins.
    if (force) {
      if (Date.now() - lastSwarmFlushAt > 10_000) {
        lastSwarmFlushAt = Date.now()
        await Promise.race([swarm.flush().catch(() => {}), new Promise(r => setTimeout(r, 3_000))])
      }
      for (const session of wakeup.getSessions(channel.key, { discoveryKey: channel.discoveryKey })) {
        try { session.broadcastLookup() } catch {}
      }
      await Promise.race([channel.update().catch(() => {}), new Promise(r => setTimeout(r, 2_000))])
    } else await applied(channel)
    const { entriesList, discoveredList, peersList } = await scanChannelView(channel.view, primaryKey)
    indexChannelRecords(primaryCache, entriesList, discoveredList, peersList, { merge: true })
    primaryHydrated = true
    primaryDirty = false
  }

  async function refreshSourceCache (src, { waitSync = true, force = false } = {}) {
    if (!src?.bee || closing) return
    // A forced tick is the background's own read: it gives the linearizer room to fetch (the 1 s
    // cap `applied()` uses is for foreground reads that must not hang the UI), then walks the view.
    if (force) {
      // A channel we already hold is a refresh: let the topic lookups answer first, or `update()`
      // returns at once against whatever peer spoke last. This is throttled across the node —
      // paying it per channel would stall rotating a large library for no extra truth.
      if (src.hydrated && Date.now() - lastSwarmFlushAt > 10_000) {
        lastSwarmFlushAt = Date.now()
        await Promise.race([swarm.flush().catch(() => {}), new Promise(r => setTimeout(r, 3_000))])
      }
      // Autobee goes quiet once a writer looks whole against the first hint it heard, and the
      // publisher's coupler skips announcing a core this peer already has open — so a follower
      // that met a partial peer first stays partial forever. Asking again makes the publisher
      // answer with its real length, which reactivates the writer and resumes the download.
      for (const session of wakeup.getSessions(src.bee.key, { discoveryKey: src.bee.discoveryKey })) {
        try { session.broadcastLookup() } catch {}
      }
      await Promise.race([src.bee.update().catch(() => {}), new Promise(r => setTimeout(r, 2_000))])
    } else if (waitSync) await applied(src.bee)
    if (!src.bee || closing) return
    const version = src.bee.view.version
    // `force` is the background tick's read: walking the view is what makes Autobase fetch the
    // blocks it linearizes next, so a view that still owes announces gets them. Gating every read
    // on `version` alone deadlocks — no read, no progress, no new version.
    if (!force && !src.dirty && src.hydrated && src.cachedRev === src.rev && src.viewVersion === version) return
    const revSnap = src.rev
    const previousVersion = src.viewVersion
    src.dirty = false
    // A follower's view grows only while something walks it. One pass can leave the linearizer
    // parked on a block nobody asked for, so the background tick keeps reading until the count
    // stops moving (bounded); that is exactly the scanning `search()` used to do on every call.
    let scan = await scanChannelView(src.bee.view, src.key)
    if (force) {
      for (let pass = 0; pass < 5 && !closing; pass++) {
        const next = await scanChannelView(src.bee.view, src.key)
        if (next.entriesList.length <= scan.entriesList.length) break
        scan = next
        await new Promise(resolve => setTimeout(resolve, 400))
      }
    }
    const { entriesList, discoveredList, peersList } = scan
    const prevCount = src.entries.length
    indexChannelRecords(src, entriesList, discoveredList, peersList, { merge: true })
    src.cachedRev = revSnap
    src.viewVersion = version
    if (revSnap > 0 || entriesList.length > 0 || discoveredList.length > 0 || peersList.length > 0) {
      src.hydrated = true
    }
    src.syncedAt = Date.now()
    if (src.hydrated) scheduleCatalogSave()
    if (entriesList.length !== prevCount) viewEpoch++
    if (previousVersion >= 0 && previousVersion !== version) update()
  }

  function ensureSourceRecord (key, alias = '') {
    let src = extraSources.get(key)
    if (src) {
      if (alias) src.alias = alias
      return { src, existed: true }
    }
    src = {
      key,
      kind: 'channel',
      alias,
      bee: null,
      opening: null,
      closing: null,
      rev: 0,
      cachedRev: -1,
      dirty: true,
      viewVersion: -1,
      hydrated: false,
      touchedAt: 0,
      syncedAt: 0,
      entries: [],
      byId: new Map(),
      bySub: new Map(),
      discovered: [],
      peers: []
    }
    const cached = savedCatalog[key]
    if (cached && Array.isArray(cached.entries)) {
      const entriesList = []
      for (const pair of cached.entries) {
        if (Array.isArray(pair) && typeof pair[0] === 'string' && pair[1]?.type === 'announce') {
          entriesList.push({ sub: pair[0], entry: pair[1] })
        }
      }
      indexChannelRecords(
        src,
        entriesList,
        Array.isArray(cached.discovered) ? cached.discovered : [],
        Array.isArray(cached.peers) ? cached.peers : []
      )
      src.hydrated = true
      src.cachedRev = 0
      src.syncedAt = Number(cached.syncedAt) || 0
    }
    extraSources.set(key, src)
    return { src, existed: false }
  }

  async function hibernateSource (src) {
    if (!src?.bee) return
    if (src.closing) return src.closing
    src.closing = (async () => {
      try {
        if (!closing && (src.dirty || src.rev !== src.cachedRev || src.viewVersion !== src.bee.view.version)) {
          await refreshSourceCache(src, { waitSync: false }).catch(() => {})
        }
      } finally {
        const oldBee = src.bee
        src.bee = null
        activeSources.delete(src.key)
        leaveOverlayTopic(`channel:${src.key}`).catch(() => {})
        if (oldBee) await oldBee.close().catch(() => {})
        src.closing = null
      }
    })()
    return src.closing
  }

  let poolGate = Promise.resolve()
  const withPoolLock = fn => {
    const next = poolGate.then(fn, fn)
    poolGate = next.catch(() => {})
    return next
  }

  async function wakeSource (key, { touch = true } = {}) {
    const k = String(key || '').trim().toLowerCase()
    const src = extraSources.get(k)
    if (!src || closing) return null
    if (src.closing) await src.closing
    if (closing || extraSources.get(k) !== src) return null
    if (src.bee) {
      if (touch) src.touchedAt = ++touchClock
      return src.bee
    }
    if (src.opening) {
      const b = await src.opening
      if (b && touch) src.touchedAt = ++touchClock
      return b
    }
    src.opening = withPoolLock(async () => {
      try {
        if (src.closing) await src.closing
        if (src.bee) {
          if (touch) src.touchedAt = ++touchClock
          return src.bee
        }
        while (!closing && activeSources.size >= activeSourceCap) {
          let victim = null
          for (const ak of activeSources) {
            if (ak === k) continue
            const cand = extraSources.get(ak)
            if (!cand?.bee || cand.closing) continue
            if (!victim || cand.touchedAt < victim.touchedAt) victim = cand
          }
          if (!victim) break
          await hibernateSource(victim)
        }
        if (closing || extraSources.get(k) !== src) return null
        let bee = null
        const subApply = makeApply(() => b4a.toString(bee.key, 'hex'))
        bee = new Autobee(store.namespace(`channel:${k}`), b4a.from(k, 'hex'), {
          apply: subApply,
          update: () => { src.dirty = true; src.rev++; update() },
          optimistic: true,
          fastForward: false,
          wakeup
        })
        await bee.ready()
        if (closing || extraSources.get(k) !== src) {
          await bee.close().catch(() => {})
          return null
        }
        src.bee = bee
        src.conns = new WeakSet()
        src.dirty = true
        src.cachedRev = -1
        src.touchedAt = touch ? ++touchClock : 0
        activeSources.add(k)
        joinOverlayTopic(`channel:${k}`, bee.key, bee.discoveryKey)
        for (const conn of peerConns) attachSource(src, conn)
        bee.update().then(() => {
          if (!closing && src.bee === bee) {
            src.dirty = true
            refreshSourceCache(src).then(() => update()).catch(() => {})
          }
        }).catch(() => {})
        onPeersChanged?.()
        return bee
      } finally {
        src.opening = null
      }
    })
    return src.opening
  }

  async function addSource (spec, { wake = true } = {}) {
    const parsed = typeof spec === 'string' ? parseUri(spec, 'channel') : parseUri(spec.uri || spec.key, spec.kind || 'channel')
    if (parsed.action === 'access') {
      await addAccessKey({ channel: parsed.channel, epoch: parsed.epoch, key: parsed.epochKey })
      return addSource({ key: parsed.channel, kind: 'channel', alias: spec?.alias ?? parsed.alias }, { wake })
    }
    if (parsed.action !== 'source') throw new Error('Expected a channel source, not a watch URI')
    const { key } = parsed
    const alias = cleanText(spec?.alias ?? parsed.alias)
    if (key === primaryKey) {
      if (alias) primaryAlias = alias
      usePrimaryChannel = true
      joinOverlayTopic(`channel:${primaryKey}`, channel.key, channel.discoveryKey)
      update()
      return { key, kind: 'channel', alias: primaryAlias, primary: true, writable: Boolean(channel.writable || (idVault && idVault.channelKey === primaryKey)) }
    }
    const { src, existed } = ensureSourceRecord(key, alias)
    if (wake) await wakeSource(key, { touch: true })
    if (!existed || alias) update()
    return { key, kind: 'channel', alias: src.alias, primary: false, writable: false }
  }

  async function removeSource (key) {
    const k = String(key || '').trim().toLowerCase()
    const src = extraSources.get(k)
    if (!src) return { removed: false }
    extraSources.delete(k)
    delete savedCatalog[k]
    scheduleCatalogSave()
    if (src.opening) await src.opening.catch(() => {})
    await hibernateSource(src)
    await leaveOverlayTopic(`channel:${k}`)
    update()
    return { removed: true }
  }

  function listSources () {
    const list = []
    if (usePrimaryChannel || channelHasEntries || primaryAlias) {
      list.push({
        key: primaryKey,
        kind: 'channel',
        alias: primaryAlias,
        primary: true,
        writable: Boolean(channel.writable || (idVault && idVault.channelKey === primaryKey))
      })
    }
    for (const s of extraSources.values()) {
      list.push({
        key: s.key,
        kind: 'channel',
        alias: s.alias,
        primary: false,
        writable: false,
        // What this follower actually holds right now: the app can show "390 videos,
        // syncing" instead of pretending a hibernated snapshot is the whole channel.
        entries: s.entries.length,
        active: Boolean(s.bee),
        hydrated: s.hydrated
      })
    }
    return list
  }

  // Register every saved channel in O(1) memory, waking only the first `activeSourceCap` at boot.
  let bootWoken = 0
  for (const s of initialSources) {
    await addSource(s, { wake: bootWoken < activeSourceCap })
    if (extraSources.size > bootWoken) bootWoken = Math.min(activeSourceCap, extraSources.size)
  }

  let rotatingSources = false
  let sourceRotateTimer = null
  function armSourceRotator () {
    if (closing) return
    let unhydrated = false
    for (const s of extraSources.values()) { if (!s.hydrated) { unhydrated = true; break } }
    const delay = unhydrated ? 1_500 : 15_000
    sourceRotateTimer = setTimeout(async () => {
      sourceRotateTimer = null
      if (closing) return
      if (!rotatingSources) {
        rotatingSources = true
        try {
          if (usePrimaryChannel || channelHasEntries) await refreshPrimaryCache({ force: true }).catch(() => {})
          const prevEpoch = viewEpoch
          // An awake channel nobody asks again keeps the view it woke with, and a frozen view
          // serves blob keys its publisher already repointed (a video that never loads).
          for (const s of [...extraSources.values()]) {
            if (closing) break
            if (s.bee && !s.closing) await refreshSourceCache(s, { force: true }).catch(() => {})
          }
          // Dormant channels take their turn even under the cap: a phone follows one channel,
          // so the cap is never reached there and this was the only path that ever woke it.
          const dormant = []
          for (const s of extraSources.values()) {
            if (!s.bee && !s.opening && !s.closing) dormant.push(s)
          }
          dormant.sort((a, b) => (a.hydrated === b.hydrated ? a.syncedAt - b.syncedAt : (a.hydrated ? 1 : -1)))
          const budget = extraSources.size > activeSourceCap ? Math.min(2, activeSourceCap) : dormant.length
          for (const s of dormant.slice(0, budget)) {
            if (closing) break
            const bee = await wakeSource(s.key, { touch: false })
            if (bee) await refreshSourceCache(s).catch(() => {})
          }
          if (viewEpoch !== prevEpoch && !closing) update()
        } finally {
          rotatingSources = false
        }
      }
      armSourceRotator()
    }, delay)
    sourceRotateTimer.unref?.()
  }
  armSourceRotator()
  undo.push(() => clearTimeout(sourceRotateTimer))

  const refreshTimer = dht ? setInterval(() => {
    if (closing || swarm.connections.size >= 16) return
    for (const d of discoveries.values()) d.refresh().catch(() => {})
  }, 20_000) : null
  refreshTimer?.unref?.()
  undo.push(() => clearInterval(refreshTimer))

  const roster = new Map()
  let scanningPeers = false
  async function scanPeers () {
    if (!dht || closing || scanningPeers) return
    scanningPeers = true
    try {
      const available = new Map()
      const now = Date.now()
      const selfHex = b4a.toString(swarm.keyPair.publicKey, 'hex')
      if (usePrimaryChannel || channelHasEntries) await refreshPrimaryCache().catch(() => {})
      for (const s of extraSources.values()) {
        if (s.bee && s.dirty) await refreshSourceCache(s).catch(() => {})
      }
      const peerLists = [
        ...(usePrimaryChannel || channelHasEntries ? [primaryCache.peers] : []),
        ...[...extraSources.values()].map(s => s.peers)
      ]
      for (const list of peerLists) {
        for (const peer of list) {
          if (!peer || peer.expiresAt <= now || peer.expiresAt > now + 60 * 60_000 || peer.publicKey === selfHex) continue
          if (available.size >= 64) break
          available.set(peer.publicKey, b4a.from(peer.publicKey, 'hex'))
        }
      }
      for (const [key, publicKey] of roster) if (!available.has(key)) swarm.leavePeer(publicKey)
      for (const [key, publicKey] of available) if (!roster.has(key)) swarm.joinPeer(publicKey)
      roster.clear()
      for (const [key, publicKey] of available) roster.set(key, publicKey)
    } finally {
      scanningPeers = false
    }
  }
  onPeersChanged = () => { scanPeers().catch(() => {}) }
  let advertisingPeer = false
  let lastPeerAdvertised = 0
  async function advertisePeer (force = false) {
    if (!dht || closing || advertisingPeer || (!force && Date.now() - lastPeerAdvertised < 3 * 60_000)) return
    if (!channel.writable && !(idVault && idVault.channelKey === primaryKey)) return
    advertisingPeer = true
    try {
      const peerOp = { type: 'peer', publicKey: b4a.toString(swarm.keyPair.publicKey, 'hex'), expiresAt: Date.now() + 10 * 60_000 }
      if (usePrimaryChannel || channelHasEntries) await append(peerOp)
      lastPeerAdvertised = Date.now()
    } finally {
      advertisingPeer = false
    }
  }
  const peerTimer = dht ? setInterval(() => {
    advertisePeer().catch(() => {})
    scanPeers().catch(() => {})
  }, 20_000) : null
  peerTimer?.unref?.()
  undo.push(() => clearInterval(peerTimer))
  if (dht) swarm.listen().then(() => advertisePeer()).catch(() => {})
  onPeersChanged()

  async function setLan (factory) {
    const previous = lan
    lan = null
    await previous?.destroy()
    if (!factory || closing || dht) return
    const next = factory(swarm.keyPair)
    next.on('connection', conn => {
      lanPeers.add(conn)
      conn.once('close', () => lanPeers.delete(conn))
      if (conn.remotePublicKey) {
        for (const sc of swarm.connections) {
          if (!sc.destroyed && sc.remotePublicKey && b4a.equals(sc.remotePublicKey, conn.remotePublicKey)) sc.destroy()
        }
      }
      trackConn(conn, traffic.lan)
    })
    try {
      await next.ready()
    } catch (err) {
      await next.destroy()
      throw err
    }
    if (closing) {
      await next.destroy()
      return
    }
    for (const discKey of lanTopics.values()) next.join(discKey)
    if (!dht) for (const topics of contentTopics.values()) for (const t of topics) next.join(t)
    lan = next
  }
  // LAN discovery is optional: a node that cannot start it (an address this machine lacks) runs without it.
  await setLan(createLan).catch(err => console.error('LAN discovery did not start: ' + (err?.message || err)))
  undo.push(() => lan?.destroy())

  // Bounded Range blob server on its own store session (its close() closes the store it is given).
  // resolve() wakes the video core with our inflightRange and flags owned cores inactive so they never linger.
  let lastHttpViewAt = 0
  const weakOwned = new Map() // blobsHex -> weak Hypercore session
  const httpOwned = new Map() // blobsHex -> { core, timer }
  async function dropOwned (hex) {
    ownedBlobs.delete(hex)
    ownedByDiscovery.delete(b4a.toString(hypercoreCrypto.discoveryKey(b4a.from(hex, 'hex')), 'hex'))
    const w = weakOwned.get(hex)
    weakOwned.delete(hex)
    const h = httpOwned.get(hex)
    if (h) { clearTimeout(h.timer); httpOwned.delete(hex) }
    if (w) await w.close().catch(() => {})
    if (h) await h.core.close().catch(() => {})
  }
  const server = createBlobRangeServer(store.session(), {
    host: streamHost,
    port: streamPort,
    token: null,
    windowBytes: isMobileWorklet ? 96 * 1024 * 1024 : 256 * 1024 * 1024,
    resolve: async (key, info) => {
      const hex = b4a.toString(key, 'hex')
      const encryptionKey = resolveBlobEncryptionKey(hex)
      if (encryptedBlobs.has(hex) && !encryptionKey) return null
      joinContentSwarm(hex)
      if (!isWorklet && !info?.head) lastHttpViewAt = Date.now()
      if (!isOwnedBlob(hex)) {
        await blobCore(hex).catch(() => {})
      } else if (!closing && ownedBlobs.has(hex) && !info?.head) {
        let rec = httpOwned.get(hex)
        if (!rec) {
          if (httpOwned.size >= 4) {
            const oldest = httpOwned.keys().next().value
            const ev = httpOwned.get(oldest)
            clearTimeout(ev.timer)
            httpOwned.delete(oldest)
            ev.core.close().catch(() => {})
          }
          const core = store.get({ key: b4a.from(hex, 'hex'), active: false })
          rec = { core, timer: null }
          httpOwned.set(hex, rec)
          await core.ready().catch(() => {})
          attachUploadWarmth(core)
        }
        clearTimeout(rec.timer)
        rec.timer = setTimeout(() => {
          if (httpOwned.get(hex) !== rec) return
          httpOwned.delete(hex)
          rec.core.close().catch(() => {})
        }, 30_000)
        rec.timer.unref?.()
        if (rec.core.opened && info?.blob?.blockOffset === 0) {
          warmAhead(rec.core, Math.floor((info?.range?.start || 0) / BLOB_BLOCK_SIZE) - 1, 32)
        }
      }
      const active = !isOwnedBlob(hex)
      return encryptionKey ? { key, encryptionKey, active } : { key, active }
    }
  })
  undo.push(() => server.close())
  await server.listen()

  function streamUrl (entry) {
    return server.getLink(b4a.from(entry.blobs, 'hex'), { blob: entry.blob })
  }

  // Local block counts per core, kept beside Hypercore from its public count() and download/append events.
  const blockCounts = new WeakMap() // core -> { blocks, slices: Map<'offset:len', blocks>, ready }
  async function syncBlockCounter (core) {
    const c = blockCounts.get(core)
    if (!c) return
    c.slices.clear()
    c.blocks = core.length > 0 ? await core.count(0, core.length) : 0
  }
  const localBlocks = core => blockCounts.get(core)?.blocks || 0

  // Multi-cursor 16 MiB parallel read-ahead across libuv workers for human viewers (skipped for bulkPeers so HiveRelays never thrash array disks).
  const bulkPeers = new Set()
  const warmCursors = new WeakMap()
  function warmAhead (core, index, lookahead = 32) {
    if (closing || !core?.opened || core.length <= 0) return
    let cursors = warmCursors.get(core)
    if (!cursors) { cursors = []; warmCursors.set(core, cursors) }
    const stride = lookahead >> 1
    const now = Date.now()
    let cur = cursors.find(c => index >= c.from - 2 && index <= c.upTo + 2)
    if (!cur) {
      if (cursors.length >= 4) {
        cursors.sort((a, b) => a.at - b.at)
        cur = cursors[0]
      } else {
        cur = { from: 0, upTo: -1, at: 0 }
        cursors.push(cur)
      }
      cur.from = Math.max(0, index)
      cur.upTo = index
    }
    cur.at = now
    if (index + (lookahead - stride) < cur.upTo) return
    const start = Math.max(0, index + 1, cur.upTo + 1)
    const end = Math.min(core.length, index + 1 + lookahead)
    if (end <= start) return
    cur.upTo = end - 1
    for (let i = start; i < end; i++) core.get(i, { wait: false }).catch(() => {})
  }
  const warmAttached = new WeakSet()
  let playerActive = false
  function setPlayerActive (active) {
    playerActive = Boolean(active)
    if (playerActive) for (const ranges of warmRanges.values()) for (const r of ranges) r.destroy()
  }

  function attachUploadWarmth (core) {
    if (!core || warmAttached.has(core)) return
    warmAttached.add(core)
    core.on('upload', (index, byteLen, peer) => {
      // Watching while seeding: our own player must never wait behind the blocks we fetch ahead
      // for someone else. Peers still get every block on demand; only the read-ahead stops.
      if (playerActive) return
      if (peer?.remotePublicKey && bulkPeers.has(b4a.toString(peer.remotePublicKey, 'hex'))) return
      warmAhead(core, index, byteLen > 0 && byteLen <= 131072 ? 128 : 32)
    })
  }
  const absentDisc = new Set()
  const discByBlob = new Map()
  function blobDisc (hex) {
    let d = discByBlob.get(hex)
    if (!d) {
      const buf = hypercoreCrypto.discoveryKey(b4a.from(hex, 'hex'))
      d = { buf, hex: b4a.toString(buf, 'hex') }
      discByBlob.set(hex, d)
    }
    return d
  }
  function recordCached (hex, length, byteLength, blocks, prevSlices = null) {
    if (!hex || isOwnedBlob(hex)) return
    const existing = cachedBlobs.get(hex)
    const slices = prevSlices || (existing && existing.length === length && existing.blocks === blocks ? existing.slices : new Map())
    cachedBlobs.set(hex, { length, byteLength, blocks, slices })
    const discHex = blobDisc(hex).hex
    if (blocks > 0) cachedByDiscovery.set(discHex, hex)
    else cachedByDiscovery.delete(discHex)
  }
  const onCoreWake = raw => {
    if (closing || !raw?.discoveryKey) return
    const discHex = b4a.toString(raw.discoveryKey, 'hex')
    storedDisc.add(discHex)
    absentDisc.delete(discHex)
    const hex = ownedByDiscovery.get(discHex) || cachedByDiscovery.get(discHex)
    if (!hex || weakOwned.has(hex) || blobCores.has(hex)) return
    queueMicrotask(() => {
      if (closing || (!ownedBlobs.has(hex) && !cachedBlobs.has(hex)) || weakOwned.has(hex) || blobCores.has(hex)) return
      const s = store.get({ key: b4a.from(hex, 'hex'), weak: true, active: false })
      weakOwned.set(hex, s)
      s.once('close', () => { if (weakOwned.get(hex) === s) weakOwned.delete(hex) })
      s.ready().then(() => { if (!s.closed && !s.closing) attachUploadWarmth(s) }).catch(() => {})
    })
  }
  store.watch(onCoreWake)
  undo.push(() => store.unwatch(onCoreWake))

  function ensureBlockCounter (core, hex = null) {
    let c = blockCounts.get(core)
    if (c) return c
    c = { blocks: 0, slices: new Map(), ready: null }
    blockCounts.set(core, c)
    c.ready = syncBlockCounter(core).then(() => {
      if (hex) recordCached(hex, core.length, core.byteLength, c.blocks, c.slices)
    }).catch(() => {})
    core.on('download', () => {
      c.blocks++
      c.slices.clear()
      if (hex) recordCached(hex, core.length, core.byteLength, c.blocks, c.slices)
    })
    core.on('append', () => {
      syncBlockCounter(core).then(() => {
        if (hex) recordCached(hex, core.length, core.byteLength, c.blocks, c.slices)
      }).catch(() => {})
    })
    attachUploadWarmth(core)
    return c
  }
  for (const s of blobSlots) ensureBlockCounter(s.core)
  const maxOpenBlobCores = isWorklet ? 6 : 24
  function evictIdleBlobCores (keepHex) {
    if (blobCores.size <= slotSet.size + maxOpenBlobCores) return
    for (const [k, v] of blobCores) {
      if (blobCores.size <= slotSet.size + maxOpenBlobCores) break
      if (k === keepHex || slotSet.has(k)) continue
      let warming = false
      for (const tag of warmRanges.keys()) {
        if (tag.startsWith(`${k}:`)) { warming = true; break }
      }
      if (warming || v.peers?.some(p => p.inflight > 0)) continue
      if (v.opened) recordCached(k, v.length, v.byteLength, localBlocks(v), blockCounts.get(v)?.slices)
      blobCores.delete(k)
      v.close().catch(() => {})
    }
  }
  async function blobCore (hex) {
    let core = blobCores.get(hex)
    if (core) {
      blobCores.delete(hex)
      blobCores.set(hex, core)
    } else {
      const slot = blobSlots.find(s => s.key === hex)
      core = slot ? slot.core : store.get({ key: b4a.from(hex, 'hex'), inflightRange })
      blobCores.set(hex, core)
    }
    if (!core.opened) await core.ready()
    await ensureBlockCounter(core, hex).ready
    recordCached(hex, core.length, core.byteLength, localBlocks(core), blockCounts.get(core)?.slices)
    evictIdleBlobCores(hex)
    return core
  }

  // Bounded head (4 MiB) + tail (1 MiB moov/cues) prefetcher so playback starts immediately.
  const warmRanges = new Map()
  async function warm (entry) {
    if (!entry?.blobs || !entry?.blob) return
    joinContentSwarm(entry.blobs)
    const core = await blobCore(entry.blobs)
    const tag = `${entry.blobs}:${entry.blob.blockOffset}`
    if (warmRanges.has(tag)) return
    if (warmRanges.size >= 8) {
      const oldest = warmRanges.keys().next().value
      for (const r of warmRanges.get(oldest)) r.destroy()
      warmRanges.delete(oldest)
    }
    const { blockOffset, blockLength, byteLength } = entry.blob
    const avgBs = Math.max(4096, Math.round((byteLength || BLOB_BLOCK_SIZE) / Math.max(1, blockLength)))
    const scale = avgBs <= 16384 ? 3 : avgBs <= 131072 ? 2 : 1
    const endBlock = blockOffset + blockLength
    const headEnd = Math.min(endBlock, blockOffset + 8 * scale)
    const ranges = [core.download({ start: blockOffset, end: headEnd, linear: true })]
    if (endBlock > headEnd) ranges.push(core.download({ start: Math.max(headEnd, endBlock - 2 * scale), end: endBlock, linear: true }))
    warmRanges.set(tag, ranges)
  }

  async function entryCachedBytes (core, entry) {
    const { blockOffset, blockLength } = entry.blob
    if (blockLength <= 0) return 0
    if (core?.opened) {
      if (core.length <= blockOffset) return 0
      const c = ensureBlockCounter(core, entry.blobs)
      await c.ready
      if (c.blocks === 0) return 0
      const len = Math.min(blockLength, core.length - blockOffset)
      const tag = `${blockOffset}:${len}`
      let blocks = blockOffset === 0 && len >= core.length ? c.blocks : c.slices.get(tag)
      if (blocks === undefined) {
        blocks = await core.count(blockOffset, blockOffset + len)
        if (c.slices.size >= 512) c.slices.clear()
        c.slices.set(tag, blocks)
      }
      if (blocks <= 0) return 0
      return blocks >= blockLength ? entry.size : Math.min(entry.size, Math.round((blocks / blockLength) * entry.size))
    }
    const meta = cachedBlobs.get(entry.blobs)
    if (!meta || meta.blocks <= 0 || meta.length <= blockOffset) return 0
    const len = Math.min(blockLength, meta.length - blockOffset)
    const tag = `${blockOffset}:${len}`
    let blocks = meta.blocks >= meta.length ? len : (blockOffset === 0 && len >= meta.length ? meta.blocks : meta.slices.get(tag))
    if (blocks === undefined) {
      const tmp = store.get({ key: b4a.from(entry.blobs, 'hex'), active: false })
      try {
        await tmp.ready()
        blocks = await tmp.count(blockOffset, blockOffset + len)
      } finally {
        await tmp.close().catch(() => {})
      }
      if (meta.slices.size >= 512) meta.slices.clear()
      meta.slices.set(tag, blocks)
    }
    if (blocks <= 0) return 0
    return blocks >= blockLength ? entry.size : Math.min(entry.size, Math.round((blocks / blockLength) * entry.size))
  }

  async function search (id = null, { source: filterSource = null, query = null, limit = 0, offset = 0 } = {}) {
    if (filterSource && extraSources.has(filterSource)) {
      await wakeSource(filterSource, { touch: true })
    }
    const activeRefresh = []
    if ((usePrimaryChannel || channelHasEntries) && (!filterSource || filterSource === primaryKey)) {
      activeRefresh.push(refreshPrimaryCache())
    }
    for (const s of extraSources.values()) {
      if (filterSource && filterSource !== s.key) continue
      if (s.bee) activeRefresh.push(refreshSourceCache(s))
    }
    if (activeRefresh.length > 0) await Promise.all(activeRefresh)

    // A listing and an id lookup both union two sources of truth: the snapshot the channel was
    // hibernated with, and its live view. Either alone loses real titles — a view can stop at a
    // region it has not downloaded yet (a co-writer's publish read as absent, the ACL test's whole
    // window), and a snapshot cannot know what arrived while the channel slept.
    const raw = []
    const pushRaw = new Map()
    const addRaw = rec => { if (!pushRaw.has(rec.key)) pushRaw.set(rec.key, rec) }
    const readView = async (view, viaKey, prefix) => {
      const range = id ? { gte: b4a.from(`${id}/`), lt: b4a.from(`${id}/\xff`) } : {}
      for await (const node of view.createReadStream(range)) {
        const sub = b4a.toString(node.key)
        if (isSystemViewKey(sub)) continue
        const op = decodeOp(node.value)
        if (op?.type === 'announce') addRaw({ key: prefix ? `${prefix}${sub}` : sub, entry: op, source: viaKey, sourceKind: 'channel' })
      }
    }
    if ((usePrimaryChannel || channelHasEntries) && (!filterSource || filterSource === primaryKey)) {
      await readView(channel.view, primaryKey, null)
      for (const { sub, entry } of primaryCache.entries) {
        if (id && entry.id !== id) continue
        addRaw({ key: sub, entry, source: primaryKey, sourceKind: 'channel' })
      }
    }
    for (const s of extraSources.values()) {
      if (filterSource && filterSource !== s.key) continue
      if (s.bee) await readView(s.bee.view, s.key, `channel:${s.key}/`)
      for (const { sub, entry } of s.entries) {
        if (id && entry.id !== id) continue
        addRaw({ key: `channel:${s.key}/${sub}`, entry, source: s.key, sourceKind: 'channel' })
      }
    }
    raw.push(...pushRaw.values())
    for (const [key, item] of ephemeralWatches) {
      if ((!id || item.entry.id === id) && (!filterSource || filterSource === 'direct')) raw.push({ key, ...item })
    }

    // Only probe cores whose discoveryKey actually exists in `storedDisc` (`O(stored_cores)` instead of `O(catalog)`).
    const toProbe = []
    const seenBlobs = new Set()
    for (const r of raw) {
      const h = r.entry.blobs
      if (seenBlobs.has(h) || ownedBlobs.has(h)) continue
      seenBlobs.add(h)
      if (slotSet.has(h) || blobCores.has(h)) { toProbe.push(h); continue }
      if (cachedBlobs.has(h)) continue
      const d = blobDisc(h)
      if (!storedDisc.has(d.hex) || absentDisc.has(d.hex)) continue
      toProbe.push(h)
    }
    for (let i = 0; i < toProbe.length; i += 16) {
      await Promise.all(toProbe.slice(i, i + 16).map(async h => {
        if (slotSet.has(h) || blobCores.has(h)) return blobCore(h)
        if (cachedBlobs.has(h)) return null
        const d = blobDisc(h)
        const exists = await coreStorage.hasCore(d.buf).catch(() => false)
        if (!exists) { absentDisc.add(d.hex); storedDisc.delete(d.hex); return null }
        const tmp = store.get({ key: b4a.from(h, 'hex'), active: false })
        try {
          await tmp.ready()
          const blocks = tmp.length > 0 ? await tmp.count(0, tmp.length) : 0
          recordCached(h, tmp.length, tmp.byteLength, blocks)
        } finally {
          await tmp.close().catch(() => {})
        }
        return null
      }))
    }

    // Deduplicate across channels/writers synchronously for the 99.9% uncached/per-video fast path,
    // only awaiting legacy shared-slot slice counts when actually present on disk.
    const files = new Map()
    const rank = r => {
      const p = r.key.split('/')
      return [!r.locked ? 1 : 0, r.local ? 1 : 0, r.cachedBytes, r.key.endsWith(':0') ? 1 : 0, p[p.length - 2] === r.source ? 1 : 0]
    }
    const better = (a, b) => {
      const x = rank(a)
      const y = rank(b)
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i]
      return false
    }
    for (const { key, entry, source, sourceKind } of raw) {
      const isPrivateEntry = Boolean(entry.wrappedKey)
      const vk = isPrivateEntry ? resolveVideoKey(entry, source) : null
      const locked = Boolean(isPrivateEntry && !vk)
      const owned = ownedBlobs.get(entry.blobs)
      let cached = 0
      if (owned) {
        cached = entry.size
      } else {
        const core = blobCores.get(entry.blobs)
        const meta = cachedBlobs.get(entry.blobs)
        if (core?.opened || (meta && meta.blocks > 0)) {
          cached = await entryCachedBytes(core, entry)
        }
      }
      if (cached > 0 && !owned) joinContentSwarm(entry.blobs, false)
      const rec = {
        key,
        entry,
        id: entry.id,
        title: cleanText(entry.title, entry.id),
        size: entry.size,
        sha256: entry.sha256,
        local: Boolean(owned) || (slotSet.has(entry.blobs) && cached >= entry.size),
        cachedBytes: cached,
        private: isPrivateEntry,
        epoch: entry.epoch || 0,
        locked,
        source,
        sourceKind
      }
      const fk = `${rec.id}/${rec.sha256}`
      if (!files.has(fk) || better(rec, files.get(fk))) files.set(fk, rec)
    }

    let list = [...files.values()]
    const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
    if (q) {
      list = list.filter(r => r.title.toLowerCase().includes(q) || r.id.toLowerCase().includes(q))
    }
    const off = Math.max(0, Number(offset) || 0)
    const lim = Math.max(0, Number(limit) || 0)
    if (off > 0 || lim > 0) {
      list = lim > 0 ? list.slice(off, off + lim) : list.slice(off)
    }
    return list.map(({ entry, ...rest }) => ({
      ...rest,
      streamUrl: streamUrl(entry),
      magnetUrl: formatWatchUri(entry)
    }))
  }

  let discoveredCache = null
  let discoveredAtEpoch = 0
  async function discoveredSources () {
    if (discoveredCache && discoveredAtEpoch === viewEpoch) return discoveredCache
    const epochSnap = viewEpoch
    if (usePrimaryChannel || channelHasEntries) await refreshPrimaryCache()
    await Promise.all([...extraSources.values()].filter(s => s.bee).map(s => refreshSourceCache(s)))
    const active = new Set(listSources().map(s => s.key))
    const found = new Map()
    const collect = list => {
      for (const item of list) {
        if (!active.has(item.key) && !found.has(item.key)) found.set(item.key, item)
      }
    }
    if (usePrimaryChannel || channelHasEntries) collect(primaryCache.discovered)
    for (const s of extraSources.values()) collect(s.discovered)
    const list = [...found.values()]
    discoveredCache = list
    discoveredAtEpoch = epochSnap
    return list
  }

  async function findEntry (key) {
    if (ephemeralWatches.has(key)) return ephemeralWatches.get(key).entry
    const subMatch = key.match(/^(?:channel|tracker):([0-9a-f]{64})\/(.+)$/)
    if (subMatch) {
      if (subMatch[1] === primaryKey) {
        await applied(channel)
        const n = await channel.view.get(b4a.from(subMatch[2]))
        const op = n ? decodeOp(n.value) : null
        if (op?.wrappedKey) resolveVideoKey(op, primaryKey)
        return op
      }
      const src = extraSources.get(subMatch[1])
      if (!src) return null
      if (!src.bee && src.hydrated && src.bySub.has(subMatch[2])) {
        const cachedOp = src.bySub.get(subMatch[2])
        if (cachedOp?.wrappedKey) resolveVideoKey(cachedOp, src.key)
        return cachedOp
      }
      const bee = await wakeSource(src.key, { touch: true })
      if (!bee) return null
      await applied(bee)
      const n = await bee.view.get(b4a.from(subMatch[2]))
      const op = n ? decodeOp(n.value) : null
      if (op?.wrappedKey) resolveVideoKey(op, src.key)
      return op
    }
    await applied(channel)
    const n = await channel.view.get(b4a.from(key))
    const op = n ? decodeOp(n.value) : null
    if (op?.wrappedKey) resolveVideoKey(op, primaryKey)
    return op
  }

  const dbDir = join(storage, 'corestore', 'db')
  function dbDiskBytes () {
    try {
      let sum = 0
      for (const f of readdirSync(dbDir)) sum += statSync(join(dbDir, f)).size
      return sum
    } catch { return 0 }
  }

  async function clearDownloadedSpans (core) {
    if (core.length > 0) await core.clear(0, core.length)
  }

  let gcQueue = Promise.resolve()
  // Any store still holding live owned blobs (plus `streaming` eviction behind a playhead) disables active blob relocation
  // (`blobGarbageCollectionPolicy: 2`) and compacts non-exclusively down to bottommost (`0`): SST tombstones unlink 100%-dead
  // `.blob` files at once without rewriting a single live `.blob` file. Passing `ageCutoff: 1.0` on a populated store forced
  // RocksDB to rewrite all 1.2 TB of live `.blob` files (~6.5 h on Unraid, 97 s Android watchdog stall on Pi); keep forced
  // `ageCutoff: 1.0` strictly for full cache wipes on pure viewers with zero local blobs left.
  function gcStorage ({ full = false, streaming = false } = {}) {
    const run = async () => {
      if (closing || coreStorage.closed) return { beforeBytes: 0, afterBytes: 0, reclaimedBytes: 0 }
      const beforeBytes = dbDiskBytes()
      await coreStorage.flush().catch(() => {})
      if (!closing && !coreStorage.closed) {
        const hasLocalBlobs = ownedBlobs.size > 0 || blobSlots.some(s => localBlocks(s.core) > 0)
        await coreStorage.compact(!streaming && full && !hasLocalBlobs
          ? { exclusive: true, blobGarbageCollectionPolicy: 1, blobGarbageCollectionAgeCutoff: 1.0, bottommostLevelCompaction: 2 }
          : { exclusive: false, blobGarbageCollectionPolicy: 2, bottommostLevelCompaction: 0 }
        )
      }
      const afterBytes = dbDiskBytes()
      return { beforeBytes, afterBytes, reclaimedBytes: Math.max(0, beforeBytes - afterBytes) }
    }
    const next = gcQueue.then(run, run)
    gcQueue = next.catch(() => ({ beforeBytes: 0, afterBytes: 0, reclaimedBytes: 0 }))
    return next
  }

  async function hasLiveBlobReference (blobsHex, blockOffset = null) {
    const matchOp = op => op?.type === 'announce' && op.blobs === blobsHex && (blockOffset === null || op.blob?.blockOffset === blockOffset)
    await channel.update()
    for await (const n of channel.view.createReadStream()) {
      const k = b4a.toString(n.key)
      if (isSystemViewKey(k)) continue
      if (matchOp(decodeOp(n.value))) return true
    }
    for (const item of ephemeralWatches.values()) {
      if (matchOp(item.entry)) return true
    }
    return false
  }

  async function gcUnreferencedSlotBlob (entry) {
    if (!entry?.blobs || !entry?.blob) return
    if (ownedBlobs.has(entry.blobs) && !slotSet.has(entry.blobs)) {
      if (await hasLiveBlobReference(entry.blobs, null)) return
      for (const [tag, ranges] of warmRanges) {
        if (tag.startsWith(`${entry.blobs}:`)) {
          for (const r of ranges) r.destroy()
          warmRanges.delete(tag)
        }
      }
      leaveContentSwarm(entry.blobs)
      await dropOwned(entry.blobs)
      const openSession = blobCores.get(entry.blobs)
      blobCores.delete(entry.blobs)
      if (openSession) await openSession.close().catch(() => {})
      const victim = store.get({ key: b4a.from(entry.blobs, 'hex') })
      await victim.ready()
      await victim.purge()
      await gcStorage({ full: false })
      return
    }
    const slot = blobSlots.find(s => s.key === entry.blobs)
    if (!slot || !(entry.blob.blockLength > 0)) return
    if (await hasLiveBlobReference(entry.blobs, entry.blob.blockOffset)) return
    const end = Math.min(slot.core.length, entry.blob.blockOffset + entry.blob.blockLength)
    if (end > entry.blob.blockOffset) {
      await slot.core.clear(entry.blob.blockOffset, end)
      await gcStorage({ full: false })
    }
  }

  // Drains spent blocks behind the playhead so tiny TV disks swallow 100 GB remuxes without choking on ENOSPC.
  // `playheadByte` is the earliest position the player is reading within the blob; the caller (the TV receiver)
  // knows it. It clears the spent stretch in 32 MiB steps (a single movie-sized clear gags the playback session
  // mutex), oldest first, up to `maxBytes` per call, then reclaims the space once. Where the last call stopped is
  // remembered, so a pass over a 77 GB film doesn't count its way up from the first block every time; one count
  // checks that nothing below it was downloaded again.
  const evictedTo = new WeakMap()
  async function evictBehind (blobsHex, blob, { playheadByte = 0, keepBehindBytes = 64 * 1024 * 1024, maxBytes = Infinity } = {}) {
    const core = blobCores.get(blobsHex)
    if (!core?.opened || !blob || blob.blockLength <= 16 || isOwnedBlob(blobsHex) || core.writable) return 0
    const bs = Math.max(65536, Math.round((blob.byteLength || BLOB_BLOCK_SIZE) / blob.blockLength))
    const playhead = blob.blockOffset + Math.floor(Math.max(0, playheadByte) / bs)
    const keepBlocks = Math.max(16, Math.ceil(keepBehindBytes / bs))
    const headGuard = blob.blockOffset + Math.max(8, Math.ceil((4 * 1024 * 1024) / bs))
    const tailGuard = blob.blockOffset + blob.blockLength - Math.max(4, Math.ceil((2 * 1024 * 1024) / bs))
    const clearTo = Math.min(tailGuard, core.length, playhead - keepBlocks)
    if (clearTo <= headGuard) return 0
    const maxBlocks = Math.max(1, Math.floor((32 * 1024 * 1024) / bs))
    const hint = Math.min(clearTo, Math.max(headGuard, evictedTo.get(core) || headGuard))
    let start = hint > headGuard && await core.count(headGuard, hint) > 0 ? headGuard : hint
    let cleared = 0
    for (; start < clearTo && !closing && cleared * bs < maxBytes; start += maxBlocks) {
      const end = Math.min(clearTo, start + maxBlocks)
      const n = await core.count(start, end)
      if (n === 0) continue
      await core.clear(start, end)
      cleared += n
    }
    evictedTo.set(core, Math.min(start, clearTo))
    if (cleared === 0) return 0
    await syncBlockCounter(core)
    recordCached(blobsHex, core.length, core.byteLength, localBlocks(core), blockCounts.get(core)?.slices)
    return (await gcStorage({ streaming: true })).reclaimedBytes
  }

  async function clearCache (key = null, { keepBlobsHex = null } = {}) {
    if (key) {
      const entry = await findEntry(key)
      if (!entry || isOwnedBlob(entry.blobs)) return { clearedBytes: 0, reclaimedBytes: 0 }
      await server.abortStreams(entry.blobs)
      const tag = `${entry.blobs}:${entry.blob.blockOffset}`
      if (warmRanges.has(tag)) {
        for (const r of warmRanges.get(tag)) r.destroy()
        warmRanges.delete(tag)
      }
      if (!slotSet.has(entry.blobs) && blobCores.has(entry.blobs)) {
        const openCore = blobCores.get(entry.blobs)
        blobCores.delete(entry.blobs)
        await openCore.close().catch(() => {})
      }
      const isSlot = slotSet.has(entry.blobs)
      const core = isSlot ? blobCores.get(entry.blobs) : store.get({ key: b4a.from(entry.blobs, 'hex'), active: false })
      let clearedBytes = 0
      let reclaimedBytes = 0
      try {
        if (!core.opened) await core.ready()
        clearedBytes = await entryCachedBytes(core, entry)
        if (clearedBytes > 0 && entry.blob.blockLength > 0 && core.length > entry.blob.blockOffset) {
          await core.clear(entry.blob.blockOffset, Math.min(core.length, entry.blob.blockOffset + entry.blob.blockLength))
          if (isSlot) await syncBlockCounter(core)
          const rem = core.length > 0 ? await core.count(0, core.length) : 0
          recordCached(entry.blobs, core.length, core.byteLength, rem)
          reclaimedBytes = (await gcStorage({ full: false })).reclaimedBytes
          update()
        }
      } finally {
        if (!isSlot) await core.close().catch(() => {})
      }
      return { clearedBytes, reclaimedBytes }
    }
    await server.abortStreams(null, { exceptHex: keepBlobsHex })
    for (const [tag, ranges] of warmRanges) {
      if (keepBlobsHex && tag.startsWith(`${keepBlobsHex}:`)) continue
      for (const r of ranges) r.destroy()
      warmRanges.delete(tag)
    }
    await search('').catch(() => {})
    let clearedBytes = 0
    const allCachedHex = [...new Set([...blobCores.keys(), ...cachedBlobs.keys()])]
    for (const hex of allCachedHex) {
      if (hex === keepBlobsHex || isOwnedBlob(hex)) continue
      if (!slotSet.has(hex) && blobCores.has(hex)) {
        const openCore = blobCores.get(hex)
        blobCores.delete(hex)
        await openCore.close().catch(() => {})
      }
      const isSlot = slotSet.has(hex)
      const core = isSlot ? blobCores.get(hex) : store.get({ key: b4a.from(hex, 'hex'), active: false })
      try {
        if (!core.opened) await core.ready()
        if (core.writable || core.length === 0) continue
        const blocks = isSlot ? (await ensureBlockCounter(core, hex).ready, localBlocks(core)) : await core.count(0, core.length)
        if (blocks > 0) {
          clearedBytes += Math.min(core.byteLength, Math.round((blocks / core.length) * core.byteLength))
          await clearDownloadedSpans(core)
          if (isSlot) await syncBlockCounter(core)
        }
        recordCached(hex, core.length, core.byteLength, 0)
      } finally {
        if (!isSlot) await core.close().catch(() => {})
      }
    }
    const { reclaimedBytes } = clearedBytes > 0 ? await gcStorage({ full: true }) : { reclaimedBytes: 0 }
    update()
    return { clearedBytes, reclaimedBytes }
  }

  // Mints a dedicated 512 KiB-piece Hypercore per video (`blockOffset: 0`) and closes the write session at rest so Corestore wakes it lazily on demand.
  // The write session is inactive: an owned core never downloads, so peers see it as an uploader from the first
  // block. Otherwise it reports "downloading" for Hypercore's 20-40 s linger after the write, and a peer whose
  // channel closes when Corestore collects the at-rest core does not reopen it.
  async function currentChannelEpoch () {
    await applied(channel)
    const n = await channel.view.get(b4a.from('meta/epoch'))
    return n ? (Number(b4a.toString(n.value)) || 1) : 1
  }

  async function put ({ id, title, expectedSize = null, private: isPrivate = false, epoch: explicitEpoch = null }, source, onData = null) {
    if (!str(id, ID)) throw new Error(`Invalid id ${id}`)
    const wantPrivate = Boolean(isPrivate || explicitEpoch)
    let videoKey = null
    let ep = 0
    let wrappedKey
    if (wantPrivate) {
      if (!idVault) throw new Error('12-word recovery vault required to encrypt private channel media')
      ep = explicitEpoch || await currentChannelEpoch()
      videoKey = hypercoreCrypto.randomBytes(32)
      wrappedKey = wrapVideoKey(videoKey, idVault.epochKey(primaryKey, ep))
    }
    const core = store.get({
      name: `video:${b4a.toString(hypercoreCrypto.randomBytes(16), 'hex')}`,
      active: false,
      ...(videoKey ? { encryption: { key: videoKey } } : {})
    })
    try {
      const hash = createHash('sha256')
      let size = 0
      let buf = []
      let bufLen = 0
      const hasher = new Transform({
        transform (chunk, cb) {
          hash.update(chunk)
          size += chunk.length
          if (onData) onData(size)
          buf.push(chunk)
          bufLen += chunk.length
          if (bufLen >= BLOB_BLOCK_SIZE) {
            const full = buf.length === 1 ? buf[0] : b4a.concat(buf, bufLen)
            let off = 0
            while (off + BLOB_BLOCK_SIZE <= full.length) this.push(full.subarray(off, off += BLOB_BLOCK_SIZE))
            buf = off < full.length ? [full.subarray(off)] : []
            bufLen = full.length - off
          }
          cb(null)
        },
        flush (cb) {
          if (bufLen > 0) this.push(bufLen === buf[0]?.length ? buf[0] : b4a.concat(buf, bufLen))
          cb(null)
        }
      })
      const blobs = new Hyperblobs(core, { blockSize: BLOB_BLOCK_SIZE })
      const writer = blobs.createWriteStream()
      await pipelinePromise(source, hasher, writer)
      if (Number.isSafeInteger(expectedSize) && expectedSize >= 0 && size !== expectedSize) {
        throw new Error(`Truncated transfer for ${id}: expected ${expectedSize} bytes, got ${size}`)
      }
      await core.ready()
      const keyHex = b4a.toString(core.key, 'hex')
      const blob = writer.id
      registerOwned(keyHex, { length: core.length, byteLength: core.byteLength })
      if (videoKey) {
        encryptedBlobs.set(keyHex, { source: primaryKey, epoch: ep, wrappedKey })
        unlockedVideoKeys.set(keyHex, videoKey)
      }
      await core.close()
      joinContentSwarm(keyHex)
      return {
        type: 'announce',
        id,
        title: cleanText(title, id),
        size,
        sha256: hash.digest('hex'),
        blobs: keyHex,
        blob,
        ...(videoKey ? { epoch: ep, wrappedKey } : {})
      }
    } catch (err) {
      await core.ready().then(() => core.purge()).catch(() => core.close().catch(() => {}))
      throw err
    }
  }

  async function publish (meta, source) {
    const op = await put(meta, source)
    await append(op)
    const writerHex = b4a.toString(channel.local.key, 'hex')
    return {
      ...op,
      key: `${op.id}/${writerHex}/${op.blobs}:${op.blob.blockOffset}`,
      channel: primaryKey,
      streamUrl: streamUrl(op),
      magnetUrl: formatWatchUri(op)
    }
  }

  async function publishChannel (metaOrOp, source = null) {
    const op = source ? await put(metaOrOp, source) : decodeOp(JSON.stringify({ ...metaOrOp, type: 'announce' }))
    if (!op || op.type !== 'announce') throw new Error('Invalid channel announce payload')
    await append(op)
    joinContentSwarm(op.blobs)
    const writerHex = b4a.toString(channel.local.key, 'hex')
    return {
      ...op,
      key: `${op.id}/${writerHex}/${op.blobs}:${op.blob.blockOffset}`,
      channel: primaryKey,
      streamUrl: streamUrl(op),
      magnetUrl: formatWatchUri(op)
    }
  }

  async function removeChannel (key) {
    return remove(key)
  }

  async function publishSource ({ sourceKey, title }) {
    const op = decodeOp(JSON.stringify({ type: 'source', sourceKey: String(sourceKey || '').toLowerCase(), kind: 'channel', title: cleanText(title, String(sourceKey).slice(0, 12)) }))
    if (!op) throw new Error('Invalid source directory record')
    await append(op)
    update()
    return op
  }

  async function unpublishSource (sourceKey) {
    const k = String(sourceKey || '').trim().toLowerCase()
    if (!HEX64.test(k)) throw new Error('Invalid source key')
    await channel.update()
    const writer = b4a.toString(channel.local.key, 'hex')
    const pfx = 'source/'
    for await (const n of channel.view.createReadStream({ gte: b4a.from(pfx), lt: b4a.from(`${pfx}\xff`) })) {
      const fullKey = b4a.toString(n.key)
      if (fullKey.endsWith(`/${k}`) && (fullKey === `source/${writer}/${k}` || (await localRole()) === 'owner')) {
        await append({ type: 'remove', key: fullKey })
      }
    }
    update()
    return { unpublished: true, key: k }
  }

  async function publishedSources () {
    const out = new Map()
    if (!usePrimaryChannel && !channelHasEntries) return []
    await applied(channel)
    const pfx = 'source/'
    for await (const node of channel.view.createReadStream({ gte: b4a.from(pfx), lt: b4a.from(`${pfx}\xff`) })) {
      const op = decodeOp(node.value)
      if (op?.type === 'source' && !out.has(op.sourceKey)) {
        out.set(op.sourceKey, { key: op.sourceKey, kind: 'channel', title: cleanText(op.title, op.sourceKey.slice(0, 12)) })
      }
    }
    return [...out.values()]
  }

  async function openUri (uri, { joinSource = true } = {}) {
    const parsed = parseUri(uri, 'channel')
    if (parsed.action === 'access') {
      await addAccessKey({ channel: parsed.channel, epoch: parsed.epoch, key: parsed.epochKey })
      const source = await addSource({ key: parsed.channel, kind: 'channel', alias: parsed.alias })
      return { action: 'access', channel: parsed.channel, epoch: parsed.epoch, source }
    }
    if (parsed.action === 'source') return { action: 'source', source: await addSource(parsed) }
    if (joinSource && parsed.sourceKey) await addSource({ key: parsed.sourceKey, kind: 'channel' }).catch(() => {})
    else if (parsed.sourceKey && !dht) {
      const sk = b4a.from(parsed.sourceKey, 'hex')
      joinOverlayTopic(`source-swarm:${parsed.sourceKey}`, sk, hypercoreCrypto.discoveryKey(sk))
    }
    const { entry } = parsed
    const key = `watch/${entry.blobs}:${entry.blob.blockOffset}`
    ephemeralWatches.set(key, { entry, source: parsed.sourceKey || 'direct', sourceKind: 'watch' })
    await warm(entry)
    update()
    return {
      action: 'watch',
      entry: {
        key,
        id: entry.id,
        title: entry.title,
        size: entry.size,
        sha256: entry.sha256,
        local: isOwnedBlob(entry.blobs),
        cachedBytes: await entryCachedBytes(blobCores.get(entry.blobs), entry),
        private: false,
        epoch: 0,
        locked: false,
        streamUrl: streamUrl(entry),
        magnetUrl: formatWatchUri(entry),
        source: parsed.sourceKey || 'direct',
        sourceKind: 'watch'
      }
    }
  }

  // One-shot zero-copy import of any pre-unification single-writer Hyperbee entries into the unified Channel.
  async function syncLocalChannel () {
    const legacyNs = store.namespace('channel')
    const probe = legacyNs.get({ name: 'bee', active: false })
    await probe.ready()
    const legacyLen = probe.length
    await probe.close()
    await channel.update()
    const existing = new Set()
    let total = 0
    for await (const n of channel.view.createReadStream()) {
      const k = b4a.toString(n.key)
      if (isSystemViewKey(k)) continue
      const op = decodeOp(n.value)
      if (op?.type === 'announce') {
        existing.add(`${op.id}/${op.blobs}:${op.blob.blockOffset}`)
        total++
      }
    }
    if (legacyLen === 0) return { backfilled: 0, total }
    const legacyBee = new Hyperbee(legacyNs, { writable: false, autoUpdate: false })
    let backfilled = 0
    try {
      await legacyBee.ready()
      for await (const n of legacyBee.createReadStream({ gte: b4a.from('entry/'), lt: b4a.from('entry/\xff') })) {
        const op = decodeOp(n.value)
        if (!op || op.type !== 'announce') continue
        const slice = `${op.id}/${op.blobs}:${op.blob.blockOffset}`
        if (!existing.has(slice)) {
          await append(op)
          joinContentSwarm(op.blobs)
          existing.add(slice)
          backfilled++
        }
      }
    } finally {
      await legacyBee.close().catch(() => {})
    }
    if (backfilled > 0) { await hydrateOwned(); update() }
    return { backfilled, total: total + backfilled }
  }

  // Splits legacy variable-block AND multi-entry shared `blobSlots` spans into dedicated 512 KiB-piece per-video Hypercores.
  async function rechunkLegacyBlobs ({ id = null, foreground = false, onMigrate = null, onProgress = null, limit = Infinity } = {}) {
    const writer = b4a.toString(channel.local.key, 'hex')
    const role = await localRole()
    const uniformByHash = new Map()
    const legacyGroups = new Map()
    const slotMap = new Map(blobSlots.map(s => [s.key, s]))
    const hasAllBlocks = async (slot, blob) => {
      if (!slot || blob.blockLength <= 0) return blob.byteLength === 0
      const end = blob.blockOffset + blob.blockLength
      if (slot.core.length < end) return false
      return slot.core.has(blob.blockOffset, end)
    }
    const addRef = async (op, fullKey) => {
      if (!slotMap.has(op.blobs)) {
        if (ownedBlobs.has(op.blobs) && op.blob?.blockOffset === 0 && isUniform512(op.blob)) {
          uniformByHash.set(`${op.sha256}:${op.size}`, { blobs: op.blobs, blob: op.blob })
        }
        return
      }
      const slot = slotMap.get(op.blobs)
      if (!(await hasAllBlocks(slot, op.blob))) return
      const oldTag = `${op.blobs}:${op.blob.blockOffset}`
      let g = legacyGroups.get(oldTag)
      if (!g) {
        g = { oldTag, blobs: op.blobs, blob: op.blob, sha256: op.sha256, size: op.size, ops: [] }
        legacyGroups.set(oldTag, g)
      }
      g.ops.push({ fullKey, op })
    }

    await channel.update()
    for await (const n of channel.view.createReadStream()) {
      const key = b4a.toString(n.key)
      if (isSystemViewKey(key)) continue
      const op = decodeOp(n.value)
      if (op?.type === 'announce' && (key.split('/')[1] === writer || role === 'owner')) await addRef(op, key)
    }

    const allGroups = [...legacyGroups.values()]
    const filtered = id ? allGroups.filter(g => g.ops.some(t => t.op.id === id)) : allGroups
    const queue = filtered.sort((a, b) => a.size - b.size)
    let migrated = 0, deduped = 0, migratedBytes = 0
    onProgress?.({ total: queue.length, migrated, deduped, remaining: queue.length, migratedBytes, currentId: null, currentTitle: null })

    for (const g of queue) {
      if (closing || migrated >= limit) break
      const sample = g.ops[0]?.op
      onProgress?.({ total: queue.length, migrated, deduped, remaining: queue.length - migrated, migratedBytes, currentId: sample.id, currentTitle: sample.title })
      const oldSlot = slotMap.get(g.blobs)
      if (!oldSlot || !(await hasAllBlocks(oldSlot, g.blob))) continue

      let target = uniformByHash.get(`${g.sha256}:${g.size}`)
      if (target && !ownedBlobs.has(target.blobs)) target = null
      if (target) {
        deduped++
      } else {
        let idx = g.blob.blockOffset
        const endIdx = g.blob.blockOffset + g.blob.blockLength
        const src = new Readable({
          read (cb) {
            if (closing) return cb(new Error('Node closing'))
            if (idx >= endIdx) { this.push(null); return cb(null) }
            const pump = () => {
              if (closing) return cb(new Error('Node closing'))
              status()
              if (!foreground && (downBps > 65536 || upBps > 65536)) { setTimeout(pump, 1500).unref?.(); return }
              const batchEnd = Math.min(endIdx, idx + 64)
              const reqs = []
              while (idx < batchEnd) reqs.push(oldSlot.core.get(idx++, { wait: false }))
              Promise.all(reqs).then(blocks => {
                if (blocks.some(b => !b)) return cb(new Error('Missing local block during rechunk'))
                for (const blk of blocks) this.push(blk)
                setTimeout(() => cb(null), 0)
              }, cb)
            }
            pump()
          }
        })
        let lastProgressBytes = 0
        const newOp = await put({ id: sample.id, title: sample.title }, src, bytes => {
          if (bytes - lastProgressBytes >= BLOB_BLOCK_SIZE) {
            lastProgressBytes = bytes
            onProgress?.({ total: queue.length, migrated, deduped, remaining: queue.length - migrated, migratedBytes: migratedBytes + bytes, currentId: sample.id, currentTitle: sample.title })
          }
        })
        if (newOp.sha256 !== g.sha256 || newOp.size !== g.size) {
          await dropOwned(newOp.blobs)
          leaveContentSwarm(newOp.blobs)
          const bad = store.get({ key: b4a.from(newOp.blobs, 'hex') })
          await bad.ready().then(() => bad.purge()).catch(() => bad.close().catch(() => {}))
          throw new Error(`SHA-256 mismatch rechunking ${sample.id}: expected ${g.sha256}, got ${newOp.sha256}`)
        }
        target = { blobs: newOp.blobs, blob: newOp.blob }
        uniformByHash.set(`${g.sha256}:${g.size}`, target)
      }

      await onMigrate?.(g.oldTag, target, sample)
      for (const { op } of g.ops) {
        await append({ ...op, blobs: target.blobs, blob: target.blob })
      }
      for (const { fullKey } of g.ops) {
        await append({ type: 'remove', key: fullKey })
      }

      const clearEnd = Math.min(oldSlot.core.length, g.blob.blockOffset + g.blob.blockLength)
      if (clearEnd > g.blob.blockOffset) {
        await oldSlot.core.clear(g.blob.blockOffset, clearEnd)
        ensureBlockCounter(oldSlot.core)
        syncBlockCounter(oldSlot.core).catch(() => {})
      }
      migrated++
      migratedBytes += g.size
      onProgress?.({ total: queue.length, migrated, deduped, remaining: queue.length - migrated, migratedBytes, currentId: null, currentTitle: null })
    }

    if (migrated > 0) update()
    return { total: queue.length, migrated, deduped, remaining: Math.max(0, queue.length - migrated), migratedBytes }
  }

  async function remove (key) {
    const cleanKey = key.startsWith(`channel:${primaryKey}/`) ? key.slice(primaryKey.length + 9) : key.startsWith(`tracker:${primaryKey}/`) ? key.slice(primaryKey.length + 9) : key
    const prev = await findEntry(cleanKey).catch(() => null)
    await append({ type: 'remove', key: cleanKey })
    await gcUnreferencedSlotBlob(prev).catch(() => {})
    update()
  }

  async function append (op) {
    usePrimaryChannel = true
    if (op.type === 'announce' || op.type === 'source') channelHasEntries = true
    joinOverlayTopic(`channel:${primaryKey}`, channel.key, channel.discoveryKey)
    const writerHex = b4a.toString(channel.local.key, 'hex')
    const ownerRec = !channel.writable && idVault ? await channel.view.get(b4a.from('meta/owner')) : null
    const canClaim = Boolean(idVault && (idVault.channelKey === primaryKey || (ownerRec && b4a.toString(ownerRec.value) === idVault.ownerPublicKey)))
    const payload = (!channel.writable && canClaim && op.type !== 'claim')
      ? { ...op, claim: idVault.signClaim(primaryKey, writerHex) }
      : op
    const before = channel.local.length
    await channel.append(b4a.from(JSON.stringify(payload)), { optimistic: !channel.writable })
    await channel.updated()
    while (channel.local.length <= before) {
      if (closing) throw new Error('Node closed before the write was durable')
      await new Promise(resolve => setTimeout(resolve, 500))
      await channel.update()
    }
    await syncWriterCores()
  }

  async function localRole () {
    const writerHex = b4a.toString(channel.local.key, 'hex')
    if (writerHex === primaryKey) return 'owner'
    await applied(channel)
    const rec = await channel.view.get(b4a.from(`writer/${writerHex}`))
    if (rec) {
      try { return JSON.parse(b4a.toString(rec.value))?.role || null } catch {}
    }
    const ownerRec = idVault ? await channel.view.get(b4a.from('meta/owner')) : null
    return idVault && (idVault.channelKey === primaryKey || (ownerRec && b4a.toString(ownerRec.value) === idVault.ownerPublicKey)) ? 'owner' : null
  }

  async function listWriters () {
    await applied(channel)
    const selfHex = b4a.toString(channel.local.key, 'hex')
    const out = new Map()
    out.set(primaryKey, { key: primaryKey, role: 'owner', alias: 'primary', self: primaryKey === selfHex })
    for await (const n of channel.view.createReadStream({ gte: b4a.from('writer/'), lt: b4a.from('writer/\xff') })) {
      const k = b4a.toString(n.key).slice(7)
      let meta = {}
      try { meta = JSON.parse(b4a.toString(n.value)) || {} } catch {}
      out.set(k, { key: k, role: meta.role || 'writer', alias: cleanText(meta.alias || ''), self: k === selfHex })
    }
    return [...out.values()]
  }

  async function grantWriter (writerKey, { role = 'writer', alias = '' } = {}) {
    const wHex = String(writerKey || '').trim().toLowerCase()
    if (!HEX64.test(wHex)) throw new Error('Writer key must be 64 hex characters')
    if (!ROLES.has(role)) throw new Error('Role must be owner, mod, or writer')
    await append({ type: 'grant', writer: wHex, role, alias: cleanText(alias) })
    return { granted: true, writer: wHex, role, alias: cleanText(alias) }
  }

  async function revokeWriter (writerKey, { purgeEntries = false } = {}) {
    const wHex = String(writerKey || '').trim().toLowerCase()
    if (!HEX64.test(wHex)) throw new Error('Writer key must be 64 hex characters')
    if (wHex === primaryKey) throw new Error('Cannot revoke the genesis channel founder')
    await append({ type: 'revoke', writer: wHex, purgeEntries: Boolean(purgeEntries) })
    update()
    return { revoked: true, writer: wHex, purgeEntries: Boolean(purgeEntries) }
  }

  async function claimWithMnemonic (phrase, { alias = '' } = {}) {
    const nextVault = deriveIdentity(phrase)
    currentMnemonic = nextVault.mnemonic
    idVault = nextVault
    saveIdentity()
    if (nextVault.channelKey !== primaryKey) {
      return { claimed: false, reopenNeeded: true, channel: nextVault.channelKey }
    }
    if (!channel.writable) {
      const writerHex = b4a.toString(channel.local.key, 'hex')
      await append({ type: 'claim', sig: nextVault.signClaim(primaryKey, writerHex), alias: cleanText(alias) })
    }
    update()
    return { claimed: true, reopenNeeded: false, channel: primaryKey, writer: b4a.toString(channel.local.key, 'hex') }
  }

  async function rotateEpoch () {
    if (!idVault) throw new Error('12-word recovery vault required to rotate subscriber epochs')
    const nextEpoch = (await currentChannelEpoch()) + 1
    await append({ type: 'epoch', epoch: nextEpoch })
    const epochKeyHex = b4a.toString(idVault.epochKey(primaryKey, nextEpoch), 'hex')
    update()
    return { epoch: nextEpoch, epochKey: epochKeyHex, accessUri: formatAccessUri(primaryKey, nextEpoch, epochKeyHex) }
  }

  async function addAccessKey ({ channel: chHex, epoch, key: keyHex }) {
    const c = String(chHex || '').trim().toLowerCase()
    const k = String(keyHex || '').trim().toLowerCase()
    const ep = Number(epoch)
    if (!HEX64.test(c) || !HEX64.test(k) || !Number.isSafeInteger(ep) || ep < 1) {
      throw new Error('Invalid subscriber access key')
    }
    accessKeys.set(`${c}:${ep}`, k)
    saveIdentity()
    update()
    return { channel: c, epoch: ep }
  }

  async function removeAccessKey (chHex, epoch = null) {
    const c = String(chHex || '').trim().toLowerCase()
    for (const k of [...accessKeys.keys()]) {
      if (epoch != null ? k === `${c}:${Number(epoch)}` : k.startsWith(`${c}:`)) accessKeys.delete(k)
    }
    for (const [blobsHex, meta] of encryptedBlobs) {
      if (meta.source === c && (epoch == null || meta.epoch === Number(epoch))) {
        unlockedVideoKeys.delete(blobsHex)
      }
    }
    saveIdentity()
    update()
    return { removed: true, channel: c }
  }

  async function identity ({ revealMnemonic = false } = {}) {
    const ep = await currentChannelEpoch()
    const role = await localRole()
    const canManageEpoch = Boolean(idVault && (primaryKey === foundedKey || idVault.channelKey === primaryKey))
    const epochKeyHex = canManageEpoch ? b4a.toString(idVault.epochKey(primaryKey, ep), 'hex') : ''
    return {
      channel: primaryKey,
      writer: b4a.toString(channel.local.key, 'hex'),
      role,
      writable: Boolean(channel.writable || role === 'owner'),
      mnemonicSet: Boolean(currentMnemonic),
      ...(revealMnemonic ? { mnemonic: currentMnemonic } : {}),
      writers: await listWriters(),
      epoch: ep,
      ...(epochKeyHex ? { epochKey: epochKeyHex, accessUri: formatAccessUri(primaryKey, ep, epochKeyHex) } : {})
    }
  }

  function setAllowedPeers (keys) {
    allowedSet = Array.isArray(keys) && keys.length ? new Set(keys.map(k => String(k).toLowerCase())) : null
  }

  // Tit-for-tat reciprocity: seeders holding cached/published blocks earn wider inflight windows than empty leechers.
  function applyReciprocity (seededBytes, txBytes, rxBytes, contributingPeers) {
    const tier = seededBytes > 0 && (txBytes > 0 || ownedBlobs.size > 0 || blobSlots.some(s => s.core.byteLength > 0) || seededBytes >= BLOB_BLOCK_SIZE)
      ? 'seeder'
      : (seededBytes > 0 || contributingPeers > 0 ? 'peer' : 'leecher')
    // Mobile/TV BareKit worklets share Android's 256 KiB rmem_max UDP socket; never let background cores blast [16,48] retransmits over Wi-Fi.
    // Measured 2026-10-29: widening this to [24,64] made a 5 GHz phone worse (erratic 0.9–15.9 MB/s,
    // decoded fps 15.7 → 11.5). Keep the small window until the socket buffers are tuned with evidence.
    const next = dht
      ? (tier === 'seeder' ? [64, 192] : tier === 'peer' ? [48, 128] : [24, 64])
      : isMobileWorklet
        ? [6, 8]
        : isWorklet
          ? [16, 48]
          : (tier === 'seeder' ? [16, 48] : tier === 'peer' ? [12, 32] : [8, 24])
    inflightRange = next
    const ratio = rxBytes > 0 ? Math.round((txBytes / rxBytes) * 100) / 100 : (txBytes > 0 ? 1 : 0)
    return { tier, seededBytes, contributingPeers, ratio, inflightMax: next[1] }
  }

  function status () {
    let rttSum = 0, rttCount = 0, retransmits = 0, contributingPeers = 0
    const now = Date.now(), dt = now - prevAt
    function measure (path, connections) {
      let rxBytes = path.closedRx, txBytes = path.closedTx
      if (connections) for (const c of connections) {
        const crx = c.rawBytesRead || c.rawStream?.bytesReceived || 0
        const ctx = c.rawBytesWritten || c.rawStream?.bytesTransmitted || 0
        if (crx > 0) contributingPeers++
        rxBytes += crx
        txBytes += ctx
        const r = c.rawStream
        if (r?.rtt > 0) { rttSum += r.rtt; rttCount++ }
        if (r?.retransmits > 0) retransmits += r.retransmits
      }
      if (dt >= 500) {
        path.downBps = Math.max(0, Math.round(((rxBytes - path.prevRx) * 1000) / dt))
        path.upBps = Math.max(0, Math.round(((txBytes - path.prevTx) * 1000) / dt))
        path.prevRx = rxBytes; path.prevTx = txBytes
      }
      return { peers: connections?.size || 0, rxBytes, txBytes, downBps: path.downBps, upBps: path.upBps }
    }
    const routes = {
      private: measure(traffic.private, dht ? swarm.connections : null),
      public: measure(traffic.public, dht ? null : swarm.connections),
      lan: measure(traffic.lan, lanPeers)
    }
    const rxBytes = routes.private.rxBytes + routes.public.rxBytes + routes.lan.rxBytes
    const txBytes = routes.private.txBytes + routes.public.txBytes + routes.lan.txBytes
    if (dt >= 500) {
      downBps = Math.max(0, Math.round(((rxBytes - prevRx) * 1000) / dt))
      upBps = Math.max(0, Math.round(((txBytes - prevTx) * 1000) / dt))
      prevRx = rxBytes; prevTx = txBytes; prevAt = now
    }
    let inflightBlocks = 0, cachedBytes = 0
    for (const [k, c] of blobCores) {
      // Display only: Hypercore has no public in-flight count, so read it off the documented `core.peers`.
      for (const p of c.peers) inflightBlocks += p.inflight || 0
      if (!isOwnedBlob(k) && c.opened && c.length > 0 && c.byteLength > 0) {
        ensureBlockCounter(c, k)
        const blocks = localBlocks(c)
        recordCached(k, c.length, c.byteLength, blocks, blockCounts.get(c)?.slices)
        if (blocks > 0) {
          cachedBytes += Math.min(coreByteLen(c), Math.round((blocks / c.length) * coreByteLen(c)))
        }
      }
    }
    for (const [k, meta] of cachedBlobs) {
      if (blobCores.has(k) || isOwnedBlob(k) || meta.blocks <= 0 || meta.length <= 0 || meta.byteLength <= 0) continue
      cachedBytes += Math.min(meta.byteLength, Math.round((meta.blocks / meta.length) * meta.byteLength))
    }
    let ownedVideoBytes = 0
    for (const v of ownedBlobs.values()) ownedVideoBytes += v.byteLength
    const blobBytes = ownedVideoBytes + blobSlots.reduce((sum, s) => {
      if (s.core.length === 0 || s.core.byteLength === 0) return sum
      ensureBlockCounter(s.core)
      const blocks = localBlocks(s.core)
      if (blocks <= 0) return sum
      return sum + (blocks >= s.core.length ? s.core.byteLength : Math.round((blocks / s.core.length) * s.core.byteLength))
    }, 0)
    const reciprocity = applyReciprocity(blobBytes + cachedBytes, txBytes, rxBytes, contributingPeers)
    const writerHex = b4a.toString(channel.local.key, 'hex')
    return {
      tracker: usePrimaryChannel || channelHasEntries ? primaryKey : '',
      channel: primaryKey,
      writer: writerHex,
      writable: Boolean(channel.writable || writerHex === primaryKey || (idVault && idVault.channelKey === primaryKey)),
      blobs: blobsKey,
      blobBytes,
      cachedBytes,
      peers: swarm.connections.size,
      lanPeers: lanPeers.size,
      downBps,
      upBps,
      rxBytes,
      txBytes,
      routes,
      inflightBlocks,
      rtt: rttCount ? Math.round(rttSum / rttCount) : 0,
      retransmits,
      sources: listSources(),
      reciprocity
    }
  }

  function coreByteLen (c) { return c.byteLength || 0 }
  // Lays bare every non-empty unified Channel core, linked-device writer core, and 512 KiB video core for supplemental HiveRelays.
  function seedableCores ({ includeCached = false } = {}) {
    const out = []
    if (channel.bootstrap.length > 0 && (channelHasEntries || ownedBlobs.size > 0)) {
      out.push({ key: primaryKey, kind: 'channel', length: channel.bootstrap.length, byteLength: channel.bootstrap.byteLength })
    }
    for (const [wHex, wc] of writerCores) {
      if (wc.opened && wc.length > 0) {
        out.push({ key: wHex, kind: 'channel', length: wc.length, byteLength: wc.byteLength })
      }
    }
    for (const [key, v] of ownedBlobs) {
      if (v.length > 0) out.push({ key, kind: 'blobs', length: v.length, byteLength: v.byteLength })
    }
    for (const s of blobSlots) {
      if (s.core.length > 0 && localBlocks(s.core) > 0) {
        out.push({ key: s.key, kind: 'blobs', length: s.core.length, byteLength: s.core.byteLength })
      }
    }
    if (includeCached) {
      for (const [k, c] of blobCores) {
        if (isOwnedBlob(k) || !c.opened || c.length === 0 || c.byteLength === 0) continue
        ensureBlockCounter(c, k)
        if (localBlocks(c) >= c.length) out.push({ key: k, kind: 'blobs', length: c.length, byteLength: c.byteLength })
      }
      for (const [k, meta] of cachedBlobs) {
        if (blobCores.has(k) || isOwnedBlob(k) || meta.length === 0 || meta.byteLength === 0) continue
        if (meta.blocks >= meta.length) out.push({ key: k, kind: 'blobs', length: meta.length, byteLength: meta.byteLength })
      }
    }
    return out
  }

  let closingPromise = null
  function close () {
    if (closingPromise) return closingPromise
    closing = true
    closingPromise = (async () => {
      clearInterval(peerTimer)
      clearInterval(refreshTimer)
      clearInterval(rotateTimer)
      clearTimeout(sourceRotateTimer)
      sourceRotateTimer = null
      flushCatalogCache()
      for (const ranges of warmRanges.values()) for (const r of ranges) r.destroy()
      warmRanges.clear()
      store.unwatch(onCoreWake)
      for (const rec of httpOwned.values()) { clearTimeout(rec.timer); await rec.core.close().catch(() => {}) }
      httpOwned.clear()
      for (const s of weakOwned.values()) await s.close().catch(() => {})
      weakOwned.clear()
      for (const wc of writerCores.values()) await wc.close().catch(() => {})
      writerCores.clear()
      await lan?.destroy()
      if (dht) await swarm.clear()
      await swarm.destroy({ force: true })
      for (const s of extraSources.values()) {
        if (s.opening) await s.opening.catch(() => {})
        if (s.closing) await s.closing.catch(() => {})
        if (s.bee) await s.bee.close().catch(() => {})
      }
      extraSources.clear()
      activeSources.clear()
      await channel.close()
      wakeup.destroy()
      await server.close()
      await store.close()
    })()
    return closingPromise
  }

  return {
    store,
    findEntry,
    blobCore,
    seedableCores,
    privateRouting: Boolean(dht),
    bootstrap: bootstrap || null,
    relayThrough: relayThrough || null,
    hasLan: () => Boolean(lan),
    hasLanPeer,
    lanEndpoint: () => lan?.port && lan?.host ? { host: lan.host, port: lan.port, publicKey: b4a.toString(swarm.keyPair.publicKey, 'hex') } : null,
    dialLanPeer: ep => { if (ep?.publicKey && ep?.host && ep?.port) lan?.dialDirect?.(ep.publicKey, ep.host, ep.port) },
    evictBehind,
    refreshBlockCount: core => syncBlockCounter(core),
    joinSourceSwarm: keyHex => {
      if (dht || closing || !str(keyHex, HEX64)) return
      const sk = b4a.from(keyHex, 'hex')
      joinOverlayTopic(`source-swarm:${keyHex}`, sk, hypercoreCrypto.discoveryKey(sk))
    },
    channel,
    tracker: channel,
    swarm,
    peerConnections: () => peerConns,
    onConnection: fn => { connListeners.add(fn); return () => connListeners.delete(fn) },
    search,
    put,
    append,
    publish,
    publishChannel,
    remove,
    removeChannel,
    publishSource,
    syncLocalChannel,
    rechunkLegacyBlobs,
    unpublishSource,
    publishedSources,
    addSource,
    removeSource,
    listSources,
    focusSource: key => wakeSource(key, { touch: true }).then(b => Boolean(b)),
    setPlayerActive: active => { setPlayerActive(active); return { ok: true } },
    activeSourceCount: () => activeSources.size,
    overlayTopicCount: () => discoveries.size,
    discoveredSources,
    openUri,
    warm,
    identity,
    listWriters,
    grantWriter,
    revokeWriter,
    claimWithMnemonic,
    rotateEpoch,
    addAccessKey,
    removeAccessKey,
    setAllowedPeers,
    clearCache,
    gcStorage,
    status,
    streamUrl,
    httpViewing: () => Date.now() - lastHttpViewAt < 3000,
    markBulkPeer: (hex, on) => { if (hex) on ? bulkPeers.add(hex) : bulkPeers.delete(hex) },
    blobServer: server,
    setLan,
    lanStats: () => (lan ? lan.stats() : null),
    close,
    get closing () { return closing }
  }
}
