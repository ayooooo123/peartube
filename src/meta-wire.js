import b4a from 'b4a'
import c from 'compact-encoding'
import hypercoreCrypto from 'hypercore-crypto'
import { HEX64, ROLES, cleanText, str } from './protocol.js'

// Deterministic binary wire spec v0x01 for PearTube's P2P Metadata & Artwork Mirror.
// Uses compact-encoding primitives in fixed field order so JS and Rust (`peartube-native`)
// produce byte-identical records verified against `spec/meta-vectors.json`.
export const META_WIRE_VERSION = 0x01
export const ART_BLOB_BLOCK_SIZE = 65536
export const META_SHARDS_PER_WRITER = 8
export const MAX_ART_BYTES = 2 * 1024 * 1024
export const META_KINDS = Object.freeze(['movie', 'series', 'album', 'artist'])
const KIND_TO_CODE = Object.freeze({ movie: 1, series: 2, album: 3, artist: 4 })
const CODE_TO_KIND = Object.freeze({ 1: 'movie', 2: 'series', 3: 'album', 4: 'artist' })
export const ART_MIMES = Object.freeze({ 1: 'image/webp', 2: 'image/jpeg', 3: 'image/png' })
export const ART_MIME_CODES = Object.freeze({ 'image/webp': 1, 'image/jpeg': 2, 'image/png': 3 })

const OP_CODES = Object.freeze({
  init: 1,
  grant: 2,
  revoke: 3,
  putShard: 4,
  putArt: 5,
  putCard: 6,
  putDetail: 7,
  setSnapshot: 8,
  remove: 9
})
const CODE_TO_OP = Object.freeze(Object.fromEntries(Object.entries(OP_CODES).map(([k, v]) => [v, k])))

const MAX_GENRES = 16
const MAX_PEOPLE = 64
const MAX_TAGS = 32
const MAX_ITEMS = 512
const MAX_EXT_IDS = 16
const MAX_LIST_IDS = 256
const MAX_BUCKET_HITS = 64
const MAX_THUMBHASH = 32
const MAX_SYNOPSIS = 8192
const META_ID_RE = /^(?:imdb:tt\d{5,10}|mb:[0-9a-f-]{8,64}|discogs:\d{1,16}|album:[0-9a-f]{20}|artist:mb:[0-9a-f-]{8,64}|artist:[0-9a-f]{20})$/
const SLUG_RE = /^[a-z0-9][a-z0-9/_-]{0,63}$/
const PREFIX3_RE = /^[a-z0-9]{1,3}$/
const TOPIC_PREFIX = b4a.from('peartube-meta/v1/')
const ZERO32 = b4a.alloc(32)

export function canonicalMetaId (raw) {
  if (typeof raw !== 'string') return null
  const s = raw.trim().toLowerCase()
  if (/^tt\d{5,10}$/.test(s)) return `imdb:${s}`
  return META_ID_RE.test(s) ? s : null
}

function requireWireMetaId (raw) {
  const id = canonicalMetaId(raw)
  if (!id || id !== raw) throw new Error(`Non-canonical wire meta id: ${raw}`)
  return id
}

export function foldText (raw) {
  return String(raw || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function foldPrefix3 (raw) {
  return foldText(raw).replace(/\s+/g, '').slice(0, 3)
}

export function metaDiscoveryTopic (metaKey) {
  const hex = asHex64(metaKey, 'Metadata channel key')
  return hypercoreCrypto.hash(b4a.concat([TOPIC_PREFIX, b4a.from(hex, 'hex')]))
}

export function artHash (bytes) {
  if (!b4a.isBuffer(bytes) || bytes.byteLength === 0 || bytes.byteLength > MAX_ART_BYTES) {
    throw new Error(`Artwork bytes must be 1..${MAX_ART_BYTES} bytes`)
  }
  return hypercoreCrypto.hash(bytes)
}

export function artHashHex (bytes) {
  return b4a.toString(artHash(bytes), 'hex')
}

export function shardIndexForHash (hashBufOrHex) {
  const byte0 = typeof hashBufOrHex === 'string'
    ? parseInt(hashBufOrHex.slice(0, 2), 16)
    : hashBufOrHex[0]
  return byte0 & (META_SHARDS_PER_WRITER - 1)
}

function asHex64 (v, label) {
  let s = ''
  if (typeof v === 'string') s = v.trim().toLowerCase()
  else if (b4a.isBuffer(v) && v.byteLength === 32) s = b4a.toString(v, 'hex')
  if (!str(s, HEX64)) throw new Error(`${label} must be 64 hex characters`)
  return s
}

function asOptHex64 (v, label) {
  return v ? asHex64(v, label) : ''
}

function asUint (v, max, label) {
  const n = Number(v ?? 0)
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new Error(`${label} out of range (0..${max})`)
  return n
}

function asKind (v) {
  const k = typeof v === 'string' ? v.trim().toLowerCase() : ''
  if (!KIND_TO_CODE[k]) throw new Error(`Invalid metadata kind: ${v}`)
  return k
}

function asMimeCode (v) {
  if (typeof v === 'number' && ART_MIMES[v]) return v
  if (typeof v === 'string' && ART_MIME_CODES[v.toLowerCase()]) return ART_MIME_CODES[v.toLowerCase()]
  throw new Error(`Unsupported artwork mime: ${v}`)
}

function asStrList (arr, maxItems, maxLen = 128) {
  if (!Array.isArray(arr)) return []
  if (arr.length > maxItems) throw new Error(`Array exceeds max ${maxItems} items`)
  return arr.map(s => String(s || '').trim().slice(0, maxLen).toWellFormed()).filter(Boolean)
}

function asThumbHash (v) {
  if (!v || v.length === 0) return b4a.alloc(0)
  let buf
  if (typeof v === 'string') buf = b4a.from(v, 'base64')
  else if (b4a.isBuffer(v)) buf = v
  else buf = b4a.from(v)
  if (buf.byteLength > MAX_THUMBHASH) throw new Error(`thumbHash exceeds ${MAX_THUMBHASH} bytes`)
  return buf
}

// Low-level compact-encoding primitives with explicit bounds enforcement before allocation.
const hex32 = {
  preencode (s) { c.fixed32.preencode(s, ZERO32) },
  encode (s, hex) { c.fixed32.encode(s, b4a.from(hex, 'hex')) },
  decode (s) { return b4a.toString(c.fixed32.decode(s), 'hex') }
}

const optHash = {
  preencode (s, hex) { c.uint8.preencode(s, hex ? 1 : 0); if (hex) c.fixed32.preencode(s, ZERO32) },
  encode (s, hex) { c.uint8.encode(s, hex ? 1 : 0); if (hex) c.fixed32.encode(s, b4a.from(hex, 'hex')) },
  decode (s) {
    const flag = c.uint8.decode(s)
    if (flag === 0) return ''
    if (flag === 1) return b4a.toString(c.fixed32.decode(s), 'hex')
    throw new Error(`Invalid optional hash flag: ${flag}`)
  }
}

const kindCodec = {
  preencode (s, k) { c.uint8.preencode(s, KIND_TO_CODE[k]) },
  encode (s, k) { c.uint8.encode(s, KIND_TO_CODE[k]) },
  decode (s) {
    const k = CODE_TO_KIND[c.uint8.decode(s)]
    if (!k) throw new Error('Invalid metadata kind code')
    return k
  }
}

const checkedUtf8 = check => ({
  preencode: c.utf8.preencode,
  encode: c.utf8.encode,
  decode (s) { return check(c.utf8.decode(s)) }
})

const wireIdCodec = checkedUtf8(requireWireMetaId)
const wireSlug = checkedUtf8(v => {
  if (!SLUG_RE.test(v)) throw new Error(`Invalid MetaList slug: ${v}`)
  return v
})
const wirePrefix = checkedUtf8(v => {
  if (!PREFIX3_RE.test(v)) throw new Error(`Invalid MetaIndexBucket prefix: ${v}`)
  return v
})

const thumbBuf = {
  preencode: c.buffer.preencode,
  encode: c.buffer.encode,
  decode (s) {
    const n = c.uint.decode(s)
    if (n > MAX_THUMBHASH) throw new Error(`thumbHash exceeds ${MAX_THUMBHASH} bytes`)
    if (s.start + n > s.end) throw new Error('Out of bounds')
    const out = s.buffer.subarray(s.start, s.start + n)
    s.start += n
    return out
  }
}

function strArr (maxItems, check = null) {
  return {
    preencode (s, list) { c.uint.preencode(s, list.length); for (const x of list) c.utf8.preencode(s, x) },
    encode (s, list) { c.uint.encode(s, list.length); for (const x of list) c.utf8.encode(s, x) },
    decode (s) {
      const n = c.uint.decode(s)
      if (n > maxItems) throw new Error(`Decoded array count ${n} exceeds limit ${maxItems}`)
      const out = new Array(n)
      for (let i = 0; i < n; i++) {
        const val = c.utf8.decode(s)
        out[i] = check ? check(val) : val
      }
      return out
    }
  }
}

function arrOf (maxItems, fields) {
  return {
    preencode (s, list) {
      c.uint.preencode(s, list.length)
      for (const it of list) for (const [k, enc] of fields) enc.preencode(s, it[k])
    },
    encode (s, list) {
      c.uint.encode(s, list.length)
      for (const it of list) for (const [k, enc] of fields) enc.encode(s, it[k])
    },
    decode (s) {
      const n = c.uint.decode(s)
      if (n > maxItems) throw new Error(`Decoded array count ${n} exceeds limit ${maxItems}`)
      const out = new Array(n)
      for (let i = 0; i < n; i++) {
        const it = {}
        for (const [k, enc] of fields) it[k] = enc.decode(s)
        out[i] = it
      }
      return out
    }
  }
}

function makeStruct (fields, normalize) {
  return {
    encode (val) {
      const norm = normalize(val)
      const state = c.state()
      c.uint8.preencode(state, META_WIRE_VERSION)
      for (const [k, enc] of fields) enc.preencode(state, norm[k])
      state.buffer = b4a.alloc(state.end)
      c.uint8.encode(state, META_WIRE_VERSION)
      for (const [k, enc] of fields) enc.encode(state, norm[k])
      return state.buffer
    },
    decode (buf) {
      if (!b4a.isBuffer(buf) || buf.byteLength < 2) throw new Error('Truncated metadata wire record')
      const state = { start: 0, end: buf.byteLength, buffer: buf }
      const ver = c.uint8.decode(state)
      if (ver !== META_WIRE_VERSION) throw new Error(`Unsupported metadata wire version: ${ver}`)
      const raw = {}
      for (const [k, enc] of fields) raw[k] = enc.decode(state)
      if (state.start !== state.end) throw new Error('Trailing bytes in metadata wire record')
      return normalize(raw)
    }
  }
}

const artPtrCodec = makeStruct([
  ['shardId', c.uint16], ['blockOffset', c.uint], ['blockLength', c.uint32],
  ['byteOffset', c.uint32], ['byteLength', c.uint32], ['width', c.uint16],
  ['height', c.uint16], ['mime', c.uint8]
], p => {
  if (!p || typeof p !== 'object') throw new Error('ArtBlobPtr must be an object')
  const blockLength = asUint(p.blockLength, 0xffffffff, 'blockLength')
  const byteLength = asUint(p.byteLength, MAX_ART_BYTES, 'byteLength')
  if (blockLength === 0 || byteLength === 0) throw new Error('ArtBlobPtr must have non-zero blockLength and byteLength')
  return {
    shardId: asUint(p.shardId, 0xffff, 'shardId'),
    blockOffset: asUint(p.blockOffset, Number.MAX_SAFE_INTEGER, 'blockOffset'),
    blockLength,
    byteOffset: asUint(p.byteOffset, 0xffffffff, 'byteOffset'),
    byteLength,
    width: asUint(p.width, 0xffff, 'width'),
    height: asUint(p.height, 0xffff, 'height'),
    mime: asMimeCode(p.mime ?? 1)
  }
})

const shardEntryCodec = makeStruct([
  ['shardId', c.uint16], ['writer', hex32], ['shardIdx', c.uint8],
  ['generation', c.uint16], ['coreKey', hex32], ['retired', c.bool]
], e => {
  if (!e || typeof e !== 'object') throw new Error('MetaShardEntry must be an object')
  return {
    shardId: asUint(e.shardId, 0xffff, 'shardId'),
    writer: asHex64(e.writer, 'writer'),
    shardIdx: asUint(e.shardIdx, META_SHARDS_PER_WRITER - 1, 'shardIdx'),
    generation: asUint(e.generation, 0xffff, 'generation'),
    coreKey: asHex64(e.coreKey, 'coreKey'),
    retired: Boolean(e.retired)
  }
})

const searchSnapshotCodec = makeStruct([
  ['coreKey', hex32], ['generation', c.uint32], ['updatedAt', c.uint], ['titleCount', c.uint32]
], s => {
  if (!s || typeof s !== 'object') throw new Error('MetaSearchSnapshot must be an object')
  return {
    coreKey: asHex64(s.coreKey, 'coreKey'),
    generation: asUint(s.generation, 0xffffffff, 'generation'),
    updatedAt: asUint(s.updatedAt, Number.MAX_SAFE_INTEGER, 'updatedAt'),
    titleCount: asUint(s.titleCount, 0xffffffff, 'titleCount')
  }
})

const cardCodec = makeStruct([
  ['id', wireIdCodec], ['kind', kindCodec], ['title', c.utf8], ['subtitle', c.utf8],
  ['year', c.uint16], ['ratingX10', c.uint16], ['genres', strArr(MAX_GENRES)],
  ['runtimeMin', c.uint16], ['thumbHash', thumbBuf], ['posterHash', optHash],
  ['backdropHash', optHash], ['updatedAt', c.uint]
], v => {
  if (!v || typeof v !== 'object') throw new Error('MetaCard must be an object')
  const id = canonicalMetaId(v.id)
  if (!id) throw new Error(`Invalid canonical meta id: ${v.id}`)
  const title = cleanText(v.title)
  if (!title) throw new Error('MetaCard title is required')
  return {
    id,
    kind: asKind(v.kind),
    title,
    subtitle: cleanText(v.subtitle || ''),
    year: asUint(v.year, 0xffff, 'year'),
    ratingX10: asUint(v.ratingX10, 100, 'ratingX10'),
    genres: asStrList(v.genres, MAX_GENRES, 48),
    runtimeMin: asUint(v.runtimeMin, 0xffff, 'runtimeMin'),
    thumbHash: asThumbHash(v.thumbHash),
    posterHash: asOptHex64(v.posterHash, 'posterHash'),
    backdropHash: asOptHex64(v.backdropHash, 'backdropHash'),
    updatedAt: asUint(v.updatedAt, Number.MAX_SAFE_INTEGER, 'updatedAt')
  }
})

const detailCodec = makeStruct([
  ['id', wireIdCodec], ['synopsis', c.utf8], ['cast', strArr(MAX_PEOPLE)],
  ['directors', strArr(MAX_PEOPLE)], ['tags', strArr(MAX_TAGS)], ['backdropHash', optHash],
  ['items', arrOf(MAX_ITEMS, [
    ['label', c.utf8], ['subId', c.utf8], ['season', c.uint16], ['number', c.uint16], ['runtimeMin', c.uint16]
  ])],
  ['externalIds', arrOf(MAX_EXT_IDS, [['key', c.utf8], ['value', c.utf8]])],
  ['updatedAt', c.uint]
], v => {
  if (!v || typeof v !== 'object') throw new Error('MetaDetail must be an object')
  const id = canonicalMetaId(v.id)
  if (!id) throw new Error(`Invalid canonical meta id: ${v.id}`)
  const rawItems = Array.isArray(v.items) ? v.items : []
  if (rawItems.length > MAX_ITEMS) throw new Error(`MetaDetail items exceed ${MAX_ITEMS}`)
  const items = rawItems.map(it => ({
    label: cleanText(it?.label || ''),
    subId: cleanText(it?.subId || ''),
    season: asUint(it?.season, 0xffff, 'season'),
    number: asUint(it?.number, 0xffff, 'number'),
    runtimeMin: asUint(it?.runtimeMin, 0xffff, 'runtimeMin')
  }))
  const rawExt = Array.isArray(v.externalIds) ? v.externalIds : []
  if (rawExt.length > MAX_EXT_IDS) throw new Error(`MetaDetail externalIds exceed ${MAX_EXT_IDS}`)
  const externalIds = rawExt.map(e => ({
    key: cleanText(e?.key || '').slice(0, 32),
    value: cleanText(e?.value || '').slice(0, 128)
  })).filter(e => e.key && e.value)
  return {
    id,
    synopsis: String(v.synopsis || '').slice(0, MAX_SYNOPSIS).toWellFormed(),
    cast: asStrList(v.cast, MAX_PEOPLE, 128),
    directors: asStrList(v.directors, MAX_PEOPLE, 128),
    tags: asStrList(v.tags, MAX_TAGS, 64),
    backdropHash: asOptHex64(v.backdropHash, 'backdropHash'),
    items,
    externalIds,
    updatedAt: asUint(v.updatedAt, Number.MAX_SAFE_INTEGER, 'updatedAt')
  }
})

const listCodec = makeStruct([
  ['kind', kindCodec], ['slug', wireSlug], ['title', c.utf8],
  ['ids', strArr(MAX_LIST_IDS, requireWireMetaId)], ['updatedAt', c.uint]
], v => {
  if (!v || typeof v !== 'object') throw new Error('MetaList must be an object')
  const slug = String(v.slug || '').trim().toLowerCase()
  if (!SLUG_RE.test(slug)) throw new Error(`Invalid MetaList slug: ${v.slug}`)
  const rawIds = Array.isArray(v.ids) ? v.ids : []
  if (rawIds.length > MAX_LIST_IDS) throw new Error(`MetaList ids exceed ${MAX_LIST_IDS}`)
  const ids = rawIds.map(id => {
    const cId = canonicalMetaId(id)
    if (!cId) throw new Error(`Invalid MetaList canonical id: ${id}`)
    return cId
  })
  return {
    kind: asKind(v.kind),
    slug,
    title: cleanText(v.title || slug),
    ids,
    updatedAt: asUint(v.updatedAt, Number.MAX_SAFE_INTEGER, 'updatedAt')
  }
})

const indexBucketCodec = makeStruct([
  ['kind', kindCodec], ['prefix', wirePrefix],
  ['hits', arrOf(MAX_BUCKET_HITS, [
    ['id', wireIdCodec], ['title', c.utf8], ['subtitle', c.utf8],
    ['year', c.uint16], ['score', c.uint16], ['thumbHash', thumbBuf], ['posterHash', optHash]
  ])],
  ['updatedAt', c.uint]
], v => {
  if (!v || typeof v !== 'object') throw new Error('MetaIndexBucket must be an object')
  const prefix = foldPrefix3(v.prefix)
  if (!PREFIX3_RE.test(prefix)) throw new Error(`Invalid MetaIndexBucket prefix: ${v.prefix}`)
  const rawHits = Array.isArray(v.hits) ? v.hits : []
  if (rawHits.length > MAX_BUCKET_HITS) throw new Error(`MetaIndexBucket hits exceed ${MAX_BUCKET_HITS}`)
  const hits = rawHits.map(h => {
    const id = canonicalMetaId(h?.id)
    if (!id) throw new Error(`Invalid MetaIndexBucket hit id: ${h?.id}`)
    return {
      id,
      title: cleanText(h?.title || id),
      subtitle: cleanText(h?.subtitle || ''),
      year: asUint(h?.year, 0xffff, 'year'),
      score: asUint(h?.score, 0xffff, 'score'),
      thumbHash: asThumbHash(h?.thumbHash),
      posterHash: asOptHex64(h?.posterHash, 'posterHash')
    }
  })
  return {
    kind: asKind(v.kind),
    prefix,
    hits,
    updatedAt: asUint(v.updatedAt, Number.MAX_SAFE_INTEGER, 'updatedAt')
  }
})

export const encodeArtPtr = artPtrCodec.encode
export const decodeArtPtr = artPtrCodec.decode
export const encodeShardEntry = shardEntryCodec.encode
export const decodeShardEntry = shardEntryCodec.decode
export const encodeSearchSnapshot = searchSnapshotCodec.encode
export const decodeSearchSnapshot = searchSnapshotCodec.decode
export const encodeCard = cardCodec.encode
export const decodeCard = cardCodec.decode
export const encodeDetail = detailCodec.encode
export const decodeDetail = detailCodec.decode
export const encodeList = listCodec.encode
export const decodeList = listCodec.decode
export const encodeIndexBucket = indexBucketCodec.encode
export const decodeIndexBucket = indexBucketCodec.decode

function normalizeOpPayload (op) {
  if (op.type === 'init') return { owner: asOptHex64(op.owner, 'owner'), alias: cleanText(op.alias || '') }
  if (op.type === 'grant') {
    const role = ROLES.has(op.role || 'writer') ? (op.role || 'writer') : null
    if (!role) throw new Error(`Invalid meta grant role: ${op.role}`)
    return { writer: asHex64(op.writer, 'writer'), role, alias: cleanText(op.alias || ''), indexer: Boolean(op.indexer) }
  }
  if (op.type === 'revoke') return { writer: asHex64(op.writer, 'writer') }
  if (op.type === 'putShard') return encodeShardEntry(op.shard)
  if (op.type === 'putArt') return { hash: asHex64(op.hash, 'hash'), ptrBuf: encodeArtPtr(op.ptr) }
  if (op.type === 'putCard') return encodeCard(op.card)
  if (op.type === 'putDetail') return encodeDetail(op.detail)
  if (op.type === 'setSnapshot') return encodeSearchSnapshot(op.snapshot)
  const key = String(op.key || '').trim()
  if (!key || key.length > 256) throw new Error('Invalid remove key')
  return { key }
}

function writeOpPayload (s, type, payload, m) {
  if (type === 'init') { optHash[m](s, payload.owner); c.utf8[m](s, payload.alias); return }
  if (type === 'grant') {
    hex32[m](s, payload.writer)
    c.utf8[m](s, payload.role)
    c.utf8[m](s, payload.alias)
    c.bool[m](s, payload.indexer)
    return
  }
  if (type === 'revoke') { hex32[m](s, payload.writer); return }
  if (type === 'putArt') { hex32[m](s, payload.hash); c.buffer[m](s, payload.ptrBuf); return }
  if (type === 'remove') { c.utf8[m](s, payload.key); return }
  c.buffer[m](s, payload)
}

// Oplog envelope for Metadata Autobee writers: `[version:u8][opCode:u8][payload...]`.
export function encodeMetaOp (op) {
  if (!op || typeof op !== 'object' || !OP_CODES[op.type]) throw new Error(`Unknown meta op: ${op?.type}`)
  const code = OP_CODES[op.type]
  const payload = normalizeOpPayload(op)
  const state = c.state()
  c.uint8.preencode(state, META_WIRE_VERSION)
  c.uint8.preencode(state, code)
  writeOpPayload(state, op.type, payload, 'preencode')
  state.buffer = b4a.alloc(state.end)
  c.uint8.encode(state, META_WIRE_VERSION)
  c.uint8.encode(state, code)
  writeOpPayload(state, op.type, payload, 'encode')
  return state.buffer
}

function decodeOpBody (state, type) {
  if (type === 'init') return { type, owner: optHash.decode(state), alias: cleanText(c.utf8.decode(state)) }
  if (type === 'grant') {
    const writer = hex32.decode(state)
    const role = c.utf8.decode(state)
    if (!ROLES.has(role)) return null
    return { type, writer, role, alias: cleanText(c.utf8.decode(state)), indexer: c.bool.decode(state) }
  }
  if (type === 'revoke') return { type, writer: hex32.decode(state) }
  if (type === 'putShard') { const raw = c.buffer.decode(state); return { type, shard: decodeShardEntry(raw), raw } }
  if (type === 'putArt') {
    const hash = hex32.decode(state)
    const raw = c.buffer.decode(state)
    return { type, hash, ptr: decodeArtPtr(raw), raw }
  }
  if (type === 'putCard') { const raw = c.buffer.decode(state); return { type, card: decodeCard(raw), raw } }
  if (type === 'putDetail') { const raw = c.buffer.decode(state); return { type, detail: decodeDetail(raw), raw } }
  if (type === 'setSnapshot') { const raw = c.buffer.decode(state); return { type, snapshot: decodeSearchSnapshot(raw), raw } }
  const key = c.utf8.decode(state)
  if (!key || key.length > 256) return null
  return { type, key }
}

export function decodeMetaOp (buf) {
  if (!b4a.isBuffer(buf) || buf.byteLength < 2) return null
  try {
    const state = { start: 0, end: buf.byteLength, buffer: buf }
    if (c.uint8.decode(state) !== META_WIRE_VERSION) return null
    const type = CODE_TO_OP[c.uint8.decode(state)]
    if (!type) return null
    const out = decodeOpBody(state, type)
    if (!out || state.start !== state.end) return null
    return out
  } catch {
    return null
  }
}
