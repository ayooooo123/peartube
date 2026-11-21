import b4a from 'b4a'

// PearTube's wire formats: what peers write into a channel, how a video's blocks are laid out, and every
// `peartube:` link. Everything else imports these; nothing here imports PearTube code.
export const ID = /^[a-z0-9]+:[a-z0-9]+(:s\d{2}e\d{2,3})?$/
export const HEX64 = /^[0-9a-f]{64}$/
export const HEX128 = /^[0-9a-f]{128}$/
export const HEX144 = /^[0-9a-f]{144}$/
export const ROLES = new Set(['owner', 'mod', 'writer'])
export const MAX_TITLE = 300
export const BLOB_BLOCK_SIZE = 512 * 1024
// A file name PearTube treats as a video or audio file (folder imports, direct links, download names).
export const MEDIA_FILE = /\.(mp4|m4v|m4a|mkv|webm|avi|mov|ts|m2ts|mts|mpg|mpeg|wmv|flv|ogv|3gp|ogg|flac|mp3|opus|wav|aac)$/i
export const isUniform512 = blob => Boolean(blob && (
  blob.byteLength === 0 || (
    blob.blockLength > 0 &&
    (blob.blockLength - 1) * BLOB_BLOCK_SIZE < blob.byteLength &&
    blob.byteLength <= blob.blockLength * BLOB_BLOCK_SIZE
  )
))

// What an entry is, for every catalog view: an episode (its id ends `:sNNeNN`, per ID) of a series, or a film. A
// title with an unambiguous trailing year ("Dune (2021)", "Dune 2021") shows the year apart.
export function describeEntry (id, title) {
  const ep = /:s(\d{2})e(\d{2,3})$/i.exec(id || '')
  const raw = String(title || '').trim()
  const year = /^(.*\S)\s*\((19|20)(\d{2})\)$/.exec(raw) || /^(.*\S)\s+(19|20)(\d{2})$/.exec(raw)
  return {
    season: ep ? Number(ep[1]) : null,
    episode: ep ? Number(ep[2]) : null,
    seriesKey: ep ? id.slice(0, ep.index).toLowerCase() : raw.toLowerCase(),
    baseTitle: year ? year[1].trim() : raw,
    year: year ? year[2] + year[3] : null
  }
}

// The container a file's first bytes name, or null when they name none of the formats MEDIA_FILE lists. A file's
// name and title are a publisher's claim; these bytes are what a relay holds. `head` needs at least 4 bytes; MPEG-TS
// and M2TS are checked at their second packet when `head` reaches it.
export function mediaFormat (head) {
  if (!head || head.length < 4) return null
  const at = (off, text) => off + text.length <= head.length && b4a.toString(head.subarray(off, off + text.length), 'latin1') === text
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return b4a.toString(head.subarray(0, Math.min(head.length, 128)), 'latin1').toLowerCase().includes('webm') ? 'webm' : 'mkv'
  }
  if (['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].some(box => at(4, box))) return at(8, 'qt  ') ? 'mov' : 'mp4'
  if (at(0, 'RIFF') && at(8, 'AVI ')) return 'avi'
  if (at(0, 'RIFF') && at(8, 'WAVE')) return 'wav'
  if (at(0, 'OggS')) return 'ogg'
  if (at(0, 'fLaC')) return 'flac'
  if (at(0, 'ID3')) return 'mp3'
  if (at(0, 'FLV') && head[3] === 0x01) return 'flv'
  if (head[0] === 0x30 && head[1] === 0x26 && head[2] === 0xb2 && head[3] === 0x75) return 'wmv'
  if (head[0] === 0x00 && head[1] === 0x00 && head[2] === 0x01 && head[3] === 0xba) return 'mpg'
  if (head[0] === 0x47 && (head.length < 189 || head[188] === 0x47)) return 'ts'
  if (head.length >= 5 && head[4] === 0x47 && (head.length < 197 || head[196] === 0x47)) return 'm2ts'
  // An MPEG audio frame header: an ADTS AAC frame has layer bits 00, an MP3 frame does not.
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return (head[1] & 0x06) === 0 ? 'aac' : 'mp3'
  return null
}

// Where peers and the apps reach a node: its HTTP API and a TV receiver's pairing/command server.
export const API_PORT = 8174
export const RECEIVER_PORT = 8176

// Every peer value is untrusted until decodeOp blesses it; typeof guards every regex.
export const str = (v, re) => typeof v === 'string' && re.test(v)
export const cleanText = (v, fallback = '') => String(v || fallback).slice(0, MAX_TITLE).toWellFormed()

// Constant-time comparison of two secrets (tokens, pairing codes): the time taken does not depend on where they differ.
export function safeEqual (a, b) {
  const ba = b4a.from(String(a || ''))
  const bb = b4a.from(String(b || ''))
  if (ba.length === 0 || ba.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i]
  return diff === 0
}
// An IPv6 address as eight numbers: `::` expanded, brackets and zone dropped, a trailing dotted IPv4 folded into the
// last two. Null if it is not an IPv6 address. Every spelling of one address gives the same groups.
export function ipv6Groups (ip) {
  let s = String(ip).toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  if (!s.includes(':')) return null
  const tail = s.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (tail) {
    const o = tail.slice(2).map(Number)
    if (o.some(n => n > 255)) return null
    s = tail[1] + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16)
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest]
  return groups.every(g => /^[0-9a-f]{1,4}$/.test(g)) ? groups.map(g => parseInt(g, 16)) : null
}
// What a music announce may say about itself beyond its title: who made it and where it sits in its release. Every
// value is free text a peer wrote, so it is clamped to MAX_TITLE and made well-formed here, once, on the way in.
// A track's own name lives here because `title` is the album on every track, the way an episode's title is its show's
// name: the clients name a group from its first row. Disc and track are NOT repeated here; they are the id's own
// `:sNNeMM` suffix, and two copies can only disagree.
const musicField = v => typeof v === 'string' && v.length > 0 ? v.slice(0, MAX_TITLE).toWellFormed() : null
export function cleanMusic (music) {
  if (!music || typeof music !== 'object') return null
  const out = {}
  for (const key of ['title', 'artist']) {
    const v = musicField(music[key])
    if (v) out[key] = v
  }
  return Object.keys(out).length > 0 ? out : null
}
function parseQuery (raw) {
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

// A watch link carries only read-only channel attribution, never a writable key.
export function formatWatchUri (entry, source = '', sourceKind = '') {
  const b = entry.blob || {}
  const q = [`id=${encodeURIComponent(entry.id)}`, `title=${encodeURIComponent(cleanText(entry.title, entry.id))}`]
  if (str(entry.sha256, HEX64)) q.push(`sha256=${entry.sha256}`)
  if (sourceKind === 'channel' && str(source, HEX64)) {
    q.push(`source=${source}`, 'kind=channel')
  }
  return `peartube://watch/${entry.blobs}:${b.blockOffset}:${b.blockLength}:${b.byteOffset}:${b.byteLength}?${q.join('&')}`
}

export function cleanName (v, fallback = 'PearTube TV') {
  return String(v || fallback).trim().slice(0, 80).toWellFormed() || fallback
}

export function formatReceiverUri ({ publicKey = '', deviceId = '', name = '', token = '', host = '', port = 0, p2p = false } = {}) {
  const target = (publicKey || deviceId || (host && port ? `${host}:${port}` : '')).toLowerCase()
  const q = []
  if (name) q.push(`name=${encodeURIComponent(cleanName(name))}`)
  if (token) q.push(`token=${encodeURIComponent(token)}`)
  if (host) q.push(`host=${encodeURIComponent(host)}`)
  if (port > 0) q.push(`port=${Number(port)}`)
  q.push(`p2p=${p2p ? 1 : 0}`)
  return `peartube://receiver/${target}${q.length ? `?${q.join('&')}` : ''}`
}

function parseReceiver (body, q) {
  const clean = body.trim().toLowerCase()
  const publicKey = HEX64.test(clean) ? clean : (HEX64.test(String(q.pk || '').toLowerCase()) ? String(q.pk).toLowerCase() : '')
  const hp = !publicKey && clean.includes(':') ? clean : ''
  const host = q.host || (hp ? hp.slice(0, hp.lastIndexOf(':')) : '')
  const port = Number(q.port || (hp ? hp.slice(hp.lastIndexOf(':') + 1) : 0)) || 0
  const deviceId = !publicKey && !hp ? clean.replace(/[^0-9a-z_-]/g, '').slice(0, 64) : String(q.id || '').slice(0, 64)
  if (!publicKey && !deviceId && !(host && port > 0)) throw new Error('Receiver URI needs a 64-hex key, device ID, or host:port')
  return { action: 'receiver', publicKey, deviceId, host, port, token: String(q.token || ''), name: cleanName(q.name || q.alias || '', 'Paired TV'), p2p: q.p2p === undefined ? Boolean(publicKey) : q.p2p === '1' }
}

// Any PearTube link or a raw 64-hex key, as the one thing it asks for: follow a channel (`source`), unlock
// paid videos (`access`), play one video (`watch`) or pair a TV (`receiver`).
export function parseUri (input) {
  if (typeof input !== 'string') throw new Error('URI or 64-hex key required')
  const raw = input.trim()
  const lower = raw.toLowerCase()
  if (HEX64.test(lower)) return { action: 'source', key: lower, kind: 'channel', alias: '' }
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
  if (verb === 'receiver' || verb === 'cast') return parseReceiver(body, q)
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

// Channel view keys that are not video entries.
export const isSystemViewKey = k => k.startsWith('peer/') || k.startsWith('source/') || k.startsWith('meta/') || k.startsWith('writer/') || k.startsWith('revoked/')
