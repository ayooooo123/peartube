// Picks the fixed media subset for the Fargate test from the home relays' HTTP API.
//
// The relay entry view carries no `blobs` field: the blob identity, block offset and
// block length live in `magnetUrl` (formatWatchUri in src/protocol.js). The `title`
// query parameter is a publisher claim and is never read or saved here.

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sampleHome } from './home.mjs'

const HEX64 = /^[0-9a-f]{64}$/i
const WATCH_URI = /^peartube:(?:\/\/)?watch\/([^?#]+)/i
const STATUS_MS = 15000
const ENTRIES_MS = 60000
const HOME_SAMPLES = 20

const MB = 1000000
export const MIN_SIZE = 100 * MB
export const MAX_SIZE = 1200 * MB
export const TOTAL_CAP = 2500 * MB

// The historical rule line, kept byte for byte: subset.json is compared on it.
const RULE = 'entries of the channel held whole by both home relays, 100 MB <= size <= 1.2 GB, smallest first, until 2.5 GB'

// Fetches JSON without ever putting the URL into an error. A caller may log the
// error, and relay URLs are operator-supplied addresses.
async function fetchJson (url, timeoutMs) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
    redirect: 'error'
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const value = await res.json()
  if (!value || typeof value !== 'object') throw new Error('reply is not an object')
  return value
}

// The blob pointer inside a watch link. Returns null for anything malformed.
// The query string, which holds the title, is deliberately not parsed.
function watchPointer (magnetUrl) {
  if (typeof magnetUrl !== 'string') return null
  const m = WATCH_URI.exec(magnetUrl)
  if (!m) return null
  const parts = m[1].split(':')
  if (parts.length !== 5) return null
  const blobs = parts[0].toLowerCase()
  const [blockOffset, blockLength] = parts.slice(1, 3).map(Number)
  if (!HEX64.test(blobs)) return null
  if (!Number.isSafeInteger(blockOffset) || blockOffset < 0) return null
  if (!Number.isSafeInteger(blockLength) || blockLength <= 0) return null
  return { blobs, blockOffset, blockLength }
}

// One /v1/entries row as the subset needs it, or null when the row cannot name a
// real core and whole copy. `local` is the relay's own "held whole" flag; the
// cached byte count is the same fact for a copy that is only kept.
function readEntry (row) {
  if (!row || typeof row !== 'object') return null
  const id = typeof row.id === 'string' ? row.id : ''
  const size = row.size
  if (!id || !Number.isSafeInteger(size) || size <= 0) return null
  const sha256 = typeof row.sha256 === 'string' ? row.sha256.toLowerCase() : ''
  if (!HEX64.test(sha256)) return null
  const pointer = watchPointer(row.magnetUrl)
  if (!pointer) return null
  const cached = Number(row.cachedBytes)
  const whole = row.local === true || (Number.isFinite(cached) && cached >= size)
  return {
    id,
    blobs: pointer.blobs,
    blockOffset: pointer.blockOffset,
    blockLength: pointer.blockLength,
    size,
    sha256,
    whole
  }
}

function trimBase (url) {
  return String(url).trim().replace(/\/+$/, '')
}

// Reads one relay's whole-copy entries, keyed by core key and slice offset (the
// same tag the blob server uses, `${blobs}:${blockOffset}`), in listing order.
async function relayEntries (url, index, selectedChannel = null) {
  const base = trimBase(url)
  let status
  let listing
  try {
    status = await fetchJson(`${base}/v1/status`, STATUS_MS)
    listing = await fetchJson(`${base}/v1/entries`, ENTRIES_MS)
  } catch {
    throw new Error(`home relay ${index} did not answer`)
  }
  const channel = selectedChannel || (typeof status.channel === 'string' ? status.channel.toLowerCase() : '')
  if (!HEX64.test(channel)) throw new Error(`home relay ${index} has no channel key`)
  if (!Array.isArray(listing.results)) throw new Error(`home relay ${index} listed no entries`)
  const byTag = new Map()
  for (const row of listing.results) {
    // The rule names entries of that channel. A relay that follows other
    // channels also lists theirs in the same reply.
    if (!row || row.sourceKind !== 'channel' || row.source !== channel) continue
    const entry = readEntry(row)
    if (!entry || !entry.whole) continue
    // A legacy shared core holds several files at different offsets, so the tag
    // is the core key plus the slice offset. Keep the first announce of a tag so
    // the listing order stays stable.
    const tag = `${entry.blobs}:${entry.blockOffset}`
    if (!byTag.has(tag)) byTag.set(tag, entry)
  }
  return { channel, byTag }
}

function sameIdentity (a, b) {
  return a.id === b.id &&
    a.blockOffset === b.blockOffset &&
    a.blockLength === b.blockLength &&
    a.size === b.size &&
    a.sha256 === b.sha256
}

// Builds the subset from relay lists that are already whole-copy filtered.
// Every relay must list the same core key and slice offset with the same announce
// facts.
function pick (relays) {
  const [first, ...others] = relays
  const common = []
  for (const [tag, entry] of first.byTag) {
    if (entry.size < MIN_SIZE || entry.size > MAX_SIZE) continue
    if (!others.every(relay => {
      const other = relay.byTag.get(tag)
      return other && sameIdentity(entry, other)
    })) continue
    common.push(entry)
  }
  // Stable sort: equal sizes keep the home relay's listing order, which is what
  // the original subset did.
  common.sort((a, b) => a.size - b.size)
  const entries = []
  let totalBytes = 0
  for (const entry of common) {
    if (totalBytes + entry.size > TOTAL_CAP) break
    entries.push({
      id: entry.id,
      blobs: entry.blobs,
      blockOffset: entry.blockOffset,
      blockLength: entry.blockLength,
      size: entry.size,
      sha256: entry.sha256
    })
    totalBytes += entry.size
  }
  return { entries, totalBytes }
}

// `pickedAt` uses the historical second-precision UTC form, so a normalized diff
// of subset.json differs only in that one value.
function pickedAt () {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00')
}

const SUBSET_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'subset.json')

export async function prepare ({ run, resultsDir, urls }) {
  if (typeof run !== 'string' || !run) throw new Error('run is required')
  if (!Array.isArray(urls) || urls.length === 0) throw new Error('home relay URLs are required')
  if (typeof resultsDir !== 'string' || !resultsDir) throw new Error('resultsDir is required')

  const relays = []
  for (let i = 0; i < urls.length; i++) relays.push(await relayEntries(urls[i], i, relays[0]?.channel))
  const channel = relays[0].channel

  const { entries, totalBytes } = pick(relays)
  if (entries.length === 0) throw new Error('no entry is held whole by every home relay in the size range')

  const subset = {
    channel,
    pickedAt: pickedAt(),
    rule: urls.length === 2 ? RULE : RULE.replace('both home relays', urls.length === 1 ? 'the home relay' : 'all home relays'),
    entries,
    totalBytes
  }
  await writeFile(SUBSET_PATH, JSON.stringify(subset, null, 1) + '\n')

  // Baseline home relay latency: one sample per relay per round, twenty rounds.
  // sampleHome records a failed request as ok:false and never the address.
  for (let i = 0; i < HOME_SAMPLES; i++) await sampleHome({ urls, resultsDir })

  return subset
}
