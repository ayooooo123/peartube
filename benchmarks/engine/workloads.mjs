// Workloads chosen to stress the JS-engine behaviours PearTube actually depends
// on. Heavy crypto/IO lives in native addons (sodium-native, bare-ffmpeg) and
// does NOT change with the engine swap, so it is deliberately excluded — what
// changes is interpreter speed on protocol glue, framing, hashing and feed
// logic. Each workload is pure JS and produces a checksummable result.

import { makeRng, stableStringify } from './harness.mjs'
import { makeFeed } from './data.mjs'

const REPO_ROOT = new URL('../../', import.meta.url)

async function tryImport(rel) {
  try {
    return await import(new URL(rel, REPO_ROOT).href)
  } catch {
    return null
  }
}

// --- self-contained codecs/hashes that mirror real cost centers -------------

// FNV-1a over a canonicalized object — identical in spirit to backend
// hash-utils.hashValue (feed-change detection). String iteration + Math.imul is
// a classic interpreter-sensitive path.
function fnvCanonical(obj) {
  const s = stableStringify(obj)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0)
}

// compact-encoding-style unsigned varint + length-prefixed frames, mirroring
// the HRPC wire path (FrameCodec uses a varint length prefix). Pure buffer/number
// work — representative of every RPC request the backend serializes.
function encodeVarint(buf, offset, value) {
  while (value >= 0x80) {
    buf[offset++] = (value & 0x7f) | 0x80
    value = Math.floor(value / 128)
  }
  buf[offset++] = value
  return offset
}
function decodeVarint(buf, state) {
  let result = 0
  let shift = 1
  let byte
  do {
    byte = buf[state.offset++]
    result += (byte & 0x7f) * shift
    shift *= 128
  } while (byte & 0x80)
  return result
}

function frameRoundTrip(messages) {
  // encode
  const enc = new TextEncoder()
  const parts = messages.map((m) => enc.encode(JSON.stringify(m)))
  let total = 0
  for (const p of parts) total += p.length + 5
  const buf = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    off = encodeVarint(buf, off, p.length)
    buf.set(p, off)
    off += p.length
  }
  // decode
  const dec = new TextDecoder()
  const state = { offset: 0 }
  let count = 0
  let bytes = 0
  while (state.offset < off) {
    const len = decodeVarint(buf, state)
    const slice = buf.subarray(state.offset, state.offset + len)
    const obj = JSON.parse(dec.decode(slice))
    bytes += obj.title ? obj.title.length : 0
    state.offset += len
    count++
  }
  return { count, bytes }
}

// 32-byte hypercore-style key hex encode/decode — done constantly across the
// hypercore/hyperbee stack.
function hexChurn(rng, n) {
  let acc = 0
  for (let i = 0; i < n; i++) {
    const bytes = new Uint8Array(32)
    for (let b = 0; b < 32; b++) bytes[b] = (rng() * 256) | 0
    let hex = ''
    for (let b = 0; b < 32; b++) hex += bytes[b].toString(16).padStart(2, '0')
    // decode back
    for (let b = 0; b < 32; b++) acc += parseInt(hex.substr(b * 2, 2), 16)
  }
  return acc
}

export async function buildWorkloads({ scale = 1 } = {}) {
  const feed = makeFeed({ entries: 200 * scale, previewsPerEntry: 8 })
  const flatVideos = feed.flatMap((e) => e.previewVideos.map((v) => ({ ...v, channelKey: e.channelKey })))
  const messages = feed.flatMap((e) => e.previewVideos.map((v) => ({ id: v.id, title: v.title, key: e.driveKey, at: v.uploadedAt })))

  const workloads = []

  // ---- real PearTube hot-path code, if importable on this checkout ----------
  const feedHydration = await tryImport('packages/app/lib/feed-hydration.js')
  if (feedHydration?.getVisibleSeededFeedEntries) {
    // Return the ordered driveKeys so the checksum is sensitive to both the
    // set AND the order the function produced (catches ordering divergence).
    workloads.push({
      name: 'feed-hydration:getVisibleSeededFeedEntries',
      fn: () => feedHydration.getVisibleSeededFeedEntries(feed, Infinity).map((e) => e.driveKey),
      iterations: 120,
    })
  }
  if (feedHydration?.getMissingChannelMetaRequests) {
    workloads.push({
      name: 'feed-hydration:getMissingChannelMetaRequests',
      fn: () => feedHydration.getMissingChannelMetaRequests(feed, {}, Infinity).map((r) => r.channelKey),
      iterations: 120,
    })
  }
  if (feedHydration?.isFeedVideoPlaybackReady) {
    // Exercises hasDirectBlobRef → /^[a-f0-9]{64}$/i regex on every video;
    // RegExp engines differ a lot between V8/QuickJS/Jerry.
    workloads.push({
      name: 'feed-hydration:playback-ready-filter(regex)',
      fn: () => flatVideos.filter((v) => feedHydration.isFeedVideoPlaybackReady(v, null)).map((v) => v.id),
      iterations: 120,
    })
  }

  const sourceMeta = await tryImport('packages/app/lib/source-metadata.js')
  const sourceExport = sourceMeta && (sourceMeta.normalizeSourceMetadata || sourceMeta.parseSourceMetadata || sourceMeta.default)
  if (typeof sourceExport === 'function') {
    workloads.push({
      name: 'source-metadata:normalize',
      fn: () => flatVideos.reduce((acc, v) => acc + (sourceExport(v) ? 1 : 0), 0),
      iterations: 100,
    })
  }

  // ---- engine-sensitive synthetic mirrors (always run) ----------------------
  workloads.push({
    name: 'hash:fnv-canonical(feed-change-detect)',
    fn: () => feed.reduce((acc, e) => acc ^ fnvCanonical(e), 0) >>> 0,
    iterations: 80,
  })

  workloads.push({
    name: 'codec:varint-frame-roundtrip(HRPC-like)',
    setup: () => messages,
    fn: (msgs) => frameRoundTrip(msgs).count,
    iterations: 80,
  })

  workloads.push({
    name: 'json:stringify+parse(cache-persist)',
    fn: () => JSON.parse(JSON.stringify(feed)).map((e) => e.driveKey),
    iterations: 80,
  })

  workloads.push({
    name: 'buffer:hex-key-encode-decode',
    setup: () => makeRng(0x1234),
    fn: (rng) => hexChurn(rng, 4000 * scale),
    iterations: 60,
  })

  workloads.push({
    name: 'collections:sort+dedup(feed-order)',
    fn: () => {
      const seen = new Set()
      const sorted = [...feed].sort((a, b) => b.manifestUpdatedAt - a.manifestUpdatedAt)
      const order = []
      for (const e of sorted) {
        if (seen.has(e.driveKey)) continue
        seen.add(e.driveKey)
        order.push(e.driveKey)
      }
      return order
    },
    iterations: 120,
  })

  return workloads
}
