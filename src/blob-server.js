// Bounded, leak-free HTTP Range blob streamer over `hypercore-byte-stream` (`prefetch: false`).
// Stock `hypercore-blob-server` leaks `ByteStream` + `core` when a client aborts during async `resolve` and queues
// `core.download` all the way to EOF, so a paused or scrubbed Range read on a 77 GB remux kept pumping onto Master's disk.
import { createServer } from 'node:http'
import c from 'compact-encoding'
import z32 from 'z32'
import HypercoreId from 'hypercore-id-encoding'
import hypercoreCrypto from 'hypercore-crypto'
import ByteStream from 'hypercore-byte-stream'
import b4a from 'b4a'

const noop = () => {}

const blobId = {
  preencode (state, b) {
    c.uint.preencode(state, b.blockOffset)
    c.uint.preencode(state, b.blockLength)
    c.uint.preencode(state, b.byteOffset)
    c.uint.preencode(state, b.byteLength)
  },
  encode (state, b) {
    c.uint.encode(state, b.blockOffset)
    c.uint.encode(state, b.blockLength)
    c.uint.encode(state, b.byteOffset)
    c.uint.encode(state, b.byteLength)
  },
  decode (state) {
    return {
      blockOffset: c.uint.decode(state),
      blockLength: c.uint.decode(state),
      byteOffset: c.uint.decode(state),
      byteLength: c.uint.decode(state)
    }
  }
}

function parseRange (raw) {
  if (!raw || !raw.startsWith('bytes=')) return null
  const parts = raw.slice(6).split('-')
  if (parts.length !== 2 || !/^\d*$/.test(parts[0]) || !/^\d*$/.test(parts[1])) return null
  if (parts[0] === '' && parts[1] === '') return null
  if (parts[0] === '') {
    const suffix = Number(parts[1])
    return suffix > 0 ? { suffix, start: 0, end: -1 } : { invalid: true }
  }
  return {
    suffix: 0,
    start: Number(parts[0]),
    end: parts[1] === '' ? -1 : Number(parts[1])
  }
}

function decodeRequest (req) {
  try {
    const info = {
      head: req.method === 'HEAD',
      range: parseRange(req.headers.range),
      token: null,
      key: null,
      blob: null,
      type: 'application/octet-stream'
    }
    const qAt = (req.url || '').indexOf('?')
    if (qAt === -1) return null
    for (const part of req.url.slice(qAt + 1).split('&')) {
      if (part.startsWith('token=')) info.token = part.slice(6)
      else if (part.startsWith('key=')) info.key = HypercoreId.decode(part.slice(4))
      else if (part.startsWith('blob=')) info.blob = c.decode(blobId, z32.decode(part.slice(5)))
      else if (part.startsWith('type=')) info.type = decodeURIComponent(part.slice(5))
    }
    if (!info.key || !info.blob) return null
    return info
  } catch {
    return null
  }
}

function bindPort (httpServer, port, address) {
  return new Promise((resolve, reject) => {
    const onError = err => {
      httpServer.removeListener('listening', onListen)
      reject(err)
    }
    const onListen = () => {
      httpServer.removeListener('error', onError)
      resolve(httpServer.address().port)
    }
    httpServer.once('error', onError)
    httpServer.once('listening', onListen)
    httpServer.listen(port, address)
  })
}

export function createBlobRangeServer (store, opts = {}) {
  const host = opts.host || '127.0.0.1'
  const address = opts.address || host
  const anyPort = opts.anyPort !== false
  const windowBytes = opts.windowBytes ?? 96 * 1024 * 1024
  const resolve = opts.resolve || (key => ({ key }))
  const token = opts.token === null ? null : (opts.token || b4a.toString(hypercoreCrypto.randomBytes(32), 'hex'))

  const connections = new Set()
  const activeStreams = new Set()
  let listeningPromise = null
  let closingPromise = null

  const server = {
    host,
    address,
    port: opts.port || 0,
    token,
    connections,
    get activeStreams () { return activeStreams.size },
    listen () {
      if (listeningPromise) return listeningPromise
      listeningPromise = (async () => {
        try {
          server.port = await bindPort(httpServer, server.port, address)
        } catch (err) {
          if (!anyPort || server.port === 0) throw err
          server.port = await bindPort(httpServer, 0, address)
        }
      })()
      return listeningPromise
    },
    getLink (key, linkOpts = {}) {
      const linkHost = linkOpts.host || server.host
      const linkPort = linkOpts.port || server.port
      const protocol = linkOpts.protocol || 'http'
      const blob = linkOpts.blob
      const mime = linkOpts.type || linkOpts.mimeType || linkOpts.mimetype || 'application/octet-stream'
      if (!blob) throw new Error('Must specify a blob')
      const portPart = (protocol === 'http' && linkPort === 80) || (protocol === 'https' && linkPort === 443) ? '' : `:${linkPort}`
      const k = typeof key === 'string' ? key : HypercoreId.encode(key)
      const b = z32.encode(c.encode(blobId, blob))
      const t = encodeURIComponent(mime)
      const tok = token ? `&token=${token}` : ''
      return `${protocol}://${linkHost}${portPart}/?key=${k}&blob=${b}&type=${t}${tok}`
    },
    // Clamps any open ByteStream and its download range shut immediately when Master wipes cached blocks.
    abortStreams (filterHex = null, { exceptHex = null } = {}) {
      const closing = []
      for (const rec of [...activeStreams]) {
        if (exceptHex && rec.hex === exceptHex) continue
        if (filterHex && rec.hex !== filterHex) continue
        closing.push(rec.abort())
      }
      return Promise.all(closing)
    },
    close () {
      if (closingPromise) return closingPromise
      closingPromise = (async () => {
        if (listeningPromise) await listeningPromise.catch(noop)
        await server.abortStreams()
        await new Promise(resolveClose => {
          let waiting = 1
          const done = () => { if (--waiting === 0) resolveClose() }
          waiting++
          httpServer.close(() => done())
          for (const sock of connections) {
            waiting++
            sock.once('close', done)
            sock.destroy()
          }
          done()
        })
        await store.close().catch(noop)
      })()
      return closingPromise
    }
  }

  const httpServer = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Range, If-Range')
    res.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range')
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.end()
      return
    }
    const info = decodeRequest(req)
    if (!info || (token !== null && info.token !== token)) {
      res.statusCode = 404
      res.end()
      return
    }
    serveBlob(info, req, res).catch(() => {
      if (!res.destroyed) res.destroy()
    })
  })

  httpServer.on('connection', sock => {
    connections.add(sock)
    sock.once('close', () => connections.delete(sock))
  })

  async function serveBlob (info, req, res) {
    let resolved = null
    let core = null
    let onEarlyClose = null
    try {
      resolved = await resolve(info.key, info)
      if (!resolved) {
        if (!res.destroyed) { res.statusCode = 404; res.end() }
        return
      }
      if (res.destroyed) return
      core = store.get(resolved)
      onEarlyClose = () => core.close().catch(noop)
      res.once('close', onEarlyClose)
      await core.ready()
    } catch {
      if (onEarlyClose) res.removeListener('close', onEarlyClose)
      if (core) await core.close().catch(noop)
      if (!res.destroyed) { res.statusCode = 404; res.end() }
      return
    }
    if (res.destroyed) {
      res.removeListener('close', onEarlyClose)
      await core.close().catch(noop)
      return
    }

    const total = info.blob.byteLength
    let start = 0
    let length = total
    if (info.range) {
      if (info.range.invalid || total <= 0) {
        res.removeListener('close', onEarlyClose)
        res.statusCode = 416
        res.setHeader('Content-Range', `bytes */${total}`)
        await core.close().catch(noop)
        res.end()
        return
      }
      const end = info.range.suffix > 0
        ? total - 1
        : (info.range.end === -1 ? total - 1 : Math.min(info.range.end, total - 1))
      start = info.range.suffix > 0 ? Math.max(0, total - info.range.suffix) : info.range.start
      if (start >= total || start > end) {
        res.removeListener('close', onEarlyClose)
        res.statusCode = 416
        res.setHeader('Content-Range', `bytes */${total}`)
        await core.close().catch(noop)
        res.end()
        return
      }
      length = end - start + 1
      res.statusCode = 206
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`)
    } else {
      res.statusCode = 200
    }

    res.setHeader('Content-Security-Policy', 'sandbox')
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', info.type)
    res.setHeader('Content-Length', String(length))

    if (info.head || length === 0) {
      res.removeListener('close', onEarlyClose)
      await core.close().catch(noop)
      res.end()
      return
    }

    const needPrefetch = windowBytes > 0 && !core.writable && resolved.active !== false && info.blob.blockLength > 0
    const uniform512 = info.blob.byteOffset === 0 && info.blob.blockLength > 0 &&
      (info.blob.blockLength - 1) * 524288 < total && total <= info.blob.blockLength * 524288
    const bs = uniform512 ? 524288 : (info.blob.blockLength > 0 ? Math.max(4096, Math.ceil(total / info.blob.blockLength)) : 524288)
    let startBlock = info.blob.blockOffset
    let endBlock = info.blob.blockOffset + info.blob.blockLength
    if (needPrefetch) {
      if (uniform512) {
        startBlock = info.blob.blockOffset + Math.floor(start / 524288)
        endBlock = Math.min(endBlock, info.blob.blockOffset + Math.ceil((start + length) / 524288))
      } else {
        if (start > 0) {
          const s0 = await core.seek(info.blob.byteOffset + start).catch(() => null)
          if (res.destroyed) { res.removeListener('close', onEarlyClose); await core.close().catch(noop); return }
          if (s0) startBlock = s0[0]
        }
        if (start + length < total) {
          const s1 = await core.seek(info.blob.byteOffset + start + length - 1).catch(() => null)
          if (res.destroyed) { res.removeListener('close', onEarlyClose); await core.close().catch(noop); return }
          if (s1) endBlock = Math.min(endBlock, s1[0] + 1)
        }
      }
    }

    res.removeListener('close', onEarlyClose)
    if (res.destroyed) {
      await core.close().catch(noop)
      return
    }

    // Feed ByteStream with prefetch off and slide one tight download window ahead of the live HTTP block cursor.
    const rs = new ByteStream(core, info.blob, { start, length, prefetch: false, highWaterMark: 2 * 1024 * 1024 })
    const hex = b4a.toString(info.key, 'hex')
    const winBlocks = needPrefetch ? Math.max(16, Math.ceil(windowBytes / bs)) : 0
    const lowWater = Math.max(8, winBlocks - Math.max(8, winBlocks >> 2))
    let dlRange = null
    let dlEnd = startBlock
    let chunksRead = 0
    let ended = false
    let done = false
    let closeDone = null

    const advanceWindow = () => {
      if (!needPrefetch || done || ended) return
      const curBlock = Math.min(endBlock, startBlock + chunksRead)
      if (dlRange && (dlEnd >= endBlock || dlEnd - curBlock > lowWater)) return
      const nextEnd = Math.min(endBlock, Math.max(curBlock + 1, curBlock + winBlocks))
      if (nextEnd <= curBlock) return
      // Mint the overlapping next window before dropping the old one so in-flight Hypercore block requests stay refcounted.
      const prev = dlRange
      dlEnd = nextEnd
      dlRange = core.download({ start: curBlock, end: nextEnd, linear: true })
      if (prev) prev.destroy()
    }

    const cleanup = abortRes => {
      if (!done) {
        done = true
        activeStreams.delete(streamRec)
        if (dlRange) { dlRange.destroy(); dlRange = null }
        rs.destroy()
        closeDone = core.close().catch(noop)
        if (abortRes && !res.destroyed) res.destroy()
      }
      return closeDone
    }

    const streamRec = { hex, abort: () => cleanup(true) }
    activeStreams.add(streamRec)
    advanceWindow()

    rs.on('data', chunk => {
      chunksRead++
      advanceWindow()
      if (!res.write(chunk)) rs.pause()
    })
    res.on('drain', () => { if (!done && !ended) rs.resume() })
    rs.once('end', () => {
      ended = true
      if (dlRange) { dlRange.destroy(); dlRange = null }
      activeStreams.delete(streamRec)
      res.end()
    })
    rs.once('error', () => cleanup(true))
    res.once('error', () => cleanup(true))
    res.once('close', () => cleanup(!ended))
  }

  return server
}
