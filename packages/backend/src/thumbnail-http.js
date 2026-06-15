/**
 * Buffered thumbnail HTTP responder for the shared blob server.
 *
 * hypercore-blob-server serves a plain (non-Range) GET by piping a ByteStream
 * and relying on stream completion to end the response — it never explicitly
 * res.end()s and leaves the connection keep-alive. Android image loaders
 * (Fresco, expo-image/Glide) reject that: the response never terminates
 * deterministically, so the image errors/hangs even though the bytes and
 * Content-Type are correct. Video is unaffected because players send Range
 * requests, which take the upstream bounded path.
 *
 * Rather than run a second HTTP server, getVideoThumbnail tags its blob URL with
 * `pt_thumbnail=1`. This handler runs inside the existing blob server's
 * `_onrequest` wrapper, before the upstream handler: for a tagged GET/HEAD it
 * reads the (small) blob into a Buffer and writes a boring, fully-controlled,
 * fixed-length response that image loaders accept. Only tagged requests are
 * intercepted; everything else (including all video Range reads) falls through
 * to hypercore-blob-server unchanged.
 */

// Defensive upper bound: only ever buffer small blobs. Thumbnails are well under
// this; a mistagged large blob falls through to the streaming path instead.
const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024
const THUMBNAIL_READ_TIMEOUT_MS = 4000
// Bounded so download + read stays under the image loader's ~8s give-up window.
const THUMBNAIL_DOWNLOAD_TIMEOUT_MS = 3500

/**
 * Serve a tagged thumbnail request from the blob server.
 * @returns {Promise<boolean>} true if it wrote the response (caller must return),
 *   false to fall through to the upstream blob-server handler.
 */
export async function serveThumbnailHttpRequest(deps, req, res) {
  const store = deps?.store
  const swarm = deps?.swarm
  const blobServer = deps?.blobServer
  if (!store) return false
  if (req?.method !== 'GET' && req?.method !== 'HEAD') return false

  let parsed
  try {
    parsed = new URL(req.url, 'http://127.0.0.1')
  } catch {
    return false
  }
  if (parsed.searchParams.get('pt_thumbnail') !== '1') return false

  // Validates the token and decodes key/blob/type against the same scheme
  // getLink used to build the URL. Lazy-imported so the module loads without
  // compact-encoding until a tagged request actually arrives.
  const { decodeBlobServerBlobRef } = await import('./blob-range-priority.js')
  const ref = decodeBlobServerBlobRef(blobServer, req)
  if (!ref) return false

  const byteLength = Number(ref.blob?.byteLength) || 0
  if (byteLength <= 0 || byteLength > MAX_THUMBNAIL_BYTES) return false

  let core = null
  try {
    core = store.get(ref.key)
    await core.ready()
    if (swarm && core.discoveryKey) {
      try { swarm.join(core.discoveryKey) } catch { /* best effort */ }
    }

    const Hyperblobs = (await import('hyperblobs')).default
    const blobs = new Hyperblobs(core)
    await blobs.ready()

    // The blob's blocks may have been evicted (or never fetched) since the URL was
    // minted — the API localizes them at resolve time, but storage eviction can
    // drop them before the image actually requests. Re-pull them on demand so the
    // read resolves instead of failing; this endpoint is the only server for the
    // tagged thumbnail path, so a miss here is a permanent blank otherwise.
    const start = ref.blob.blockOffset
    const end = ref.blob.blockOffset + Math.max(1, ref.blob.blockLength || 1)
    let local = false
    try { local = Boolean(await core.has(start, end)) } catch { local = false }
    if (!local) {
      let range = null
      try {
        range = core.download({ start, end, linear: true })
        await Promise.race([
          typeof range?.done === 'function' ? range.done() : Promise.resolve(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('thumbnail block download timeout')), THUMBNAIL_DOWNLOAD_TIMEOUT_MS))
        ])
      } catch { /* best effort */ } finally {
        try { range?.destroy?.() } catch { /* best effort */ }
      }
    }

    const buf = await Promise.race([
      blobs.get(ref.blob),
      new Promise((_, reject) => setTimeout(() => reject(new Error('thumbnail read timeout')), THUMBNAIL_READ_TIMEOUT_MS))
    ])
    if (!buf || !buf.length) return false
    if (res.headersSent || res.writableEnded) return true

    // Set headers then writeHead(status) + end — the exact pattern the OPTIONS
    // branch uses, which bare-http1 is proven to flush correctly. Setting
    // res.statusCode alone did not reliably emit the response.
    res.setHeader('Content-Type', ref.type || 'image/jpeg')
    res.setHeader('Content-Length', String(buf.length))
    res.setHeader('Connection', 'close')
    res.setHeader('Accept-Ranges', 'none')
    res.setHeader('Cache-Control', 'no-store')
    res.writeHead(200)
    res.end(req.method === 'HEAD' ? undefined : buf)
    return true
  } catch {
    return false
  } finally {
    // Close the per-request core session so repeated thumbnail loads don't leak.
    try { const closing = core?.close?.(); if (closing?.catch) closing.catch(() => {}) } catch { /* best effort */ }
  }
}
