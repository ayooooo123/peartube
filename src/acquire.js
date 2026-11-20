import { createReadStream, mkdtempSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { createHash, randomUUID, randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { dirname, join } from 'node:path'
import b4a from 'b4a'
import { Readable } from 'streamx'
import ByteStream from 'hypercore-byte-stream'
import { downloadPage } from './identify.js'
import { checkUrlHost, guardedLookup, privateUrlsAllowed } from './ssrf.js'

const TERMINAL_STATUS = new Set([400, 401, 403, 404, 410, 451])
const DEFAULT_HEADERS = { 'user-agent': 'VLC/3.0.18 LibVLC/3.0.18', accept: '*/*', 'accept-encoding': 'identity' }

function mergeHeaders (...sets) {
  const out = { ...DEFAULT_HEADERS }
  for (const [k, v] of sets.flatMap(s => Object.entries(s || {}))) {
    if (v != null) out[k.toLowerCase()] = String(v)
  }
  return out
}

function waitAbortable (ms, controller) {
  return new Promise((resolve, reject) => {
    if (controller.aborted) return reject(new Error('Cancelled'))
    const timer = setTimeout(() => { controller.onabort = null; resolve() }, ms)
    timer.unref?.()
    controller.onabort = () => { clearTimeout(timer); reject(new Error('Cancelled')) }
  })
}

// Jobs hold private source URLs and auth headers, so they stay collared inside a 0600 file and
// never leak into Corestore where replication would serve them to any stranger who names the core.
// What anyone may see of a job: no source secrets, no internal announce payload, no per-video key.
export const publicJob = ({ source, announce, existing, storeKey, etag, lastModified, hashState, hashBytes, ...job }) => job

export function createAcquirer (node, file, {
  concurrency = 4,
  retryDelay = 15_000,
  stallTimeout = 30_000,
  maxReconnects = 8,
  maxAttempts = 4,
  defaultChannel = false,
  ubitConfigDir = join(dirname(file), 'ubit'),
  ubit = '',
  onDone = null,
  // A copy of another channel's core that gains no block for this long gives way to the job's own URL.
  copyStall = 120_000,
  // Loopback and private source hosts (src/ssrf.js); link-local is refused either way.
  allowPrivateUrls = privateUrlsAllowed()
} = {}) {
  const workRoot = dirname(file)
  try {
    for (const entry of readdirSync(workRoot)) {
      if (entry.startsWith('ubit-dl-')) rmSync(join(workRoot, entry), { recursive: true, force: true })
    }
  } catch {}
  let jobs = []
  try { jobs = JSON.parse(readFileSync(file, 'utf8')) } catch {}
  for (const job of jobs) {
    if (job.status === 'running' || job.status === 'copying' || (job.status === 'failed' && job.source)) {
      job.status = job.announce ? 'announcing' : 'queued'
    }
  }
  const running = new Map()
  // A closed acquirer leaves jobs.json wet as it was at close so the next boot re-queues in-flight work.
  let closed = false

  function save () {
    if (closed) return
    writeFileSync(file + '.tmp', JSON.stringify(jobs), { mode: 0o600 })
    renameSync(file + '.tmp', file)
  }

  // Every hop, the first URL and each redirect, must name a host src/ssrf.js allows; names are checked as they resolve.
  function openSource (url, headers, controller, redirects = 0, timeout = stallTimeout) {
    return new Promise((resolve, reject) => {
      if (controller.aborted) return reject(new Error('Cancelled'))
      const parsed = new URL(url)
      try { checkUrlHost(parsed, allowPrivateUrls) } catch (err) { return reject(err) }
      const fn = parsed.protocol === 'https:' ? httpsRequest : httpRequest
      let settled = false
      const onAbort = () => req.destroy(new Error('Cancelled'))
      const finish = (err, res) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (controller.onabort === onAbort) controller.onabort = null
        err ? reject(err) : resolve(res)
      }
      // A fresh agent: a pooled socket is reused without a lookup, so one an unguarded request left would skip the guard.
      const req = fn(parsed, { headers, agent: false, lookup: guardedLookup(allowPrivateUrls) }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 10) {
          res.resume?.()
          const nextUrl = new URL(res.headers.location, parsed)
          // Strip bearer/cookie secrets when a redirect jumps across origins onto presigned CDN/S3/R2 edges.
          const nextHeaders = nextUrl.origin === parsed.origin ? headers : (({ authorization, cookie, ...rest }) => rest)(headers)
          settled = true
          clearTimeout(timer)
          if (controller.onabort === onAbort) controller.onabort = null
          openSource(nextUrl.href, nextHeaders, controller, redirects + 1, timeout).then(resolve, reject)
          return
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume?.()
          const ra = Number(res.headers['retry-after'])
          const retryAfter = Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0, 300_000)
          finish(Object.assign(new Error(`Source answered ${res.statusCode}`), { status: res.statusCode, retryAfter }))
          return
        }
        finish(null, res)
      })
      const timer = setTimeout(() => req.destroy(new Error('Source timed out')), timeout)
      timer.unref?.()
      controller.onabort = onAbort
      req.once('error', err => finish(err))
      req.end()
    })
  }

  // Re-stitches stalled or dropped mid-film HTTP streams via Range: bytes=offset- so node.put never purges partial cores.
  function readResumable (job, url, baseHeaders, first, total, controller, startOffset = 0) {
    const etag = typeof first.headers.etag === 'string' && !first.headers.etag.startsWith('W/') ? first.headers.etag : null
    return Readable.from((async function * () {
      let cur = first
      let offset = startOffset
      let reconnects = 0
      let retryAfter = 0
      let lastErr = null
      // Range resumes may force upstream (e.g. Usenet skipReader) to chew through several MiB before emitting byte 1;
      // widen the pre-first-byte leash on each retry, then snap right back to stallTimeout once bytes start flowing.
      const seekTimeout = () => stallTimeout * Math.min(reconnects + 2, 6)
      for (;;) {
        if (controller.aborted || closed) { cur?.destroy?.(); throw new Error('Cancelled') }
        if (!cur) {
          const delay = retryAfter || Math.min(retryDelay || 250, 250 * 2 ** Math.min(reconnects, 6))
          retryAfter = 0
          await waitAbortable(delay, controller)
          const rangeHeaders = { ...baseHeaders, range: `bytes=${offset}-`, ...(etag ? { 'if-range': etag } : {}) }
          try {
            cur = await openSource(url, rangeHeaders, controller, 0, seekTimeout())
          } catch (err) {
            if (controller.aborted || closed) throw new Error('Cancelled')
            if (TERMINAL_STATUS.has(err.status) || ++reconnects > maxReconnects) throw err
            lastErr = err
            retryAfter = err.retryAfter || 0
            continue
          }
          const m = String(cur.headers['content-range'] || '').match(/^bytes\s+(\d+)-/i)
          if (cur.statusCode !== 206 || !m || Number(m[1]) !== offset) {
            cur.destroy?.()
            throw new Error(`Truncated transfer for ${job.id}: expected ${total} bytes, got ${offset}`)
          }
        }
        const startOffset = offset
        let timer = null
        const arm = ms => {
          clearTimeout(timer)
          timer = setTimeout(() => cur.destroy(new Error('Source stalled')), ms)
          timer.unref?.()
        }
        const onAbort = () => cur.destroy(new Error('Cancelled'))
        controller.onabort = onAbort
        try {
          arm(offset > 0 ? seekTimeout() : stallTimeout)
          for await (const chunk of cur) {
            clearTimeout(timer)
            offset += chunk.byteLength
            yield chunk
            arm(stallTimeout)
          }
          if (total == null || offset >= total) return
        } catch (err) {
          if (controller.aborted || closed) throw new Error('Cancelled')
          if (total == null || offset === 0) throw err
          lastErr = err
        } finally {
          clearTimeout(timer)
          if (controller.onabort === onAbort) controller.onabort = null
          cur.destroy?.()
          cur = null
        }
        if (offset > startOffset) reconnects = 0
        else if (++reconnects > maxReconnects) {
          throw new Error(`Truncated transfer for ${job.id}: expected ${total} bytes, got ${offset}${lastErr ? ` (${lastErr.message})` : ''}`)
        }
      }
    })())
  }

  // A feed item another followed channel already publishes (same sha256 and size): take that core from peers instead
  // of downloading the file again, so every holder seeds one swarm, and keep it out of the cache ceiling. The other
  // channel's sha256 is only its claim, so the whole copy is hashed here against the feed's digest before this relay
  // announces it; a copy that does not match is cleared. Returns the announce for this job, or null when no block
  // arrived for `copyStall` or the bytes are not the feed's file; the job then downloads from its URL.
  async function copyExisting (job, controller) {
    const src = job.existing
    const { blockOffset: start, blockLength } = src.blob
    const op = { type: 'announce', id: job.id, title: job.title, size: src.size, sha256: src.sha256, blobs: src.blobs, blob: src.blob }
    Object.assign(job, { status: 'copying', total: src.size, bytes: 0 })
    save()
    node.keepCopy(src.blobs)
    await node.warm(op)
    let core = null
    let range = null
    let have = -1
    let progressAt = Date.now()
    try {
      while (true) {
        if (controller.aborted) throw new Error('Cancelled')
        if (!core || core.closed) {
          range?.destroy()
          core = await node.blobCore(src.blobs)
          range = core.download({ start, end: start + blockLength })
        }
        const now = await core.count(start, start + blockLength)
        if (now > have) { have = now; progressAt = Date.now() }
        job.bytes = Math.min(src.size, Math.round(src.size * have / blockLength))
        if (have >= blockLength) break
        if (Date.now() - progressAt > copyStall) return null
        await waitAbortable(1000, controller)
      }
    } finally {
      range?.destroy()
    }
    if (src.blob.byteLength === src.size && await localSha256(core, src.blob) === src.sha256) return op
    node.keepCopy(src.blobs, false)
    if (src.key) await node.clearCache(src.key).catch(() => {})
    return null
  }
  // The file's bytes from local blocks only (its own session: the stream closes the core it reads).
  async function localSha256 (core, blob) {
    const hash = createHash('sha256')
    for await (const chunk of new ByteStream(core.session(), blob, { prefetch: false })) hash.update(chunk)
    return hash.digest('hex')
  }

  // A job is spent only once its announce is durable; save the stored blob's announce immediately after put()
  // without triggering foreign-cache GC so a restart re-announces instead of orphaning the core and re-fetching.
  async function run (job) {
    // Older jobs (and every job on its first attempt) get a durable core name, so the next restart resumes this attempt.
    // A job left `announcing` has no source until its announce is durable; reading through it spun `next()` on itself.
    if (job.source && !job.source.page && !job.store) job.store = newStore()
    // A private job from before per-job keys existed gets one now, or a restart reopens its core under a second key.
    if (job.private && job.store && !job.storeKey) job.storeKey = randomBytes(32).toString('hex')
    job.status = job.announce ? 'announcing' : 'running'
    job.error = null
    save()
    const controller = { aborted: false, onabort: null, abort () { this.aborted = true; this.onabort?.() } }
    running.set(job, controller)
    try {
      if (!job.announce && job.existing) {
        const op = await copyExisting(job, controller)
        if (closed) throw new Error('Closed')
        if (op) {
          Object.assign(job, { status: 'announcing', announce: op, source: null })
        } else {
          node.keepCopy(job.existing.blobs, false)
          Object.assign(job, { status: 'running', existing: null, bytes: 0 })
        }
        save()
      }
      if (!job.announce) {
        let op
        if (job.source.page) {
          // Page links run through `ubit get` on every attempt so adaptive DASH/HLS tracks mux cleanly without expiring URLs.
          const tmpDir = mkdtempSync(join(workRoot, 'ubit-dl-'))
          try {
            job.total = null
            job.bytes = 0
            const dl = await downloadPage(job.source.url, tmpDir, {
              configDir: ubitConfigDir,
              ubit,
              stallTimeout,
              controller,
              onProgress ({ bytes, total }) {
                job.bytes = bytes
                if (total != null) job.total = total
              }
            })
            if (job.status === 'cancelled') throw new Error('Cancelled')
            if (closed) throw new Error('Closed')
            const total = dl.size ?? statSync(dl.path).size
            job.total = total
            op = await node.put({ id: job.id, title: job.title, expectedSize: total, private: Boolean(job.private) }, createReadStream(dl.path), bytes => { job.bytes = bytes })
          } finally {
            rmSync(tmpDir, { recursive: true, force: true })
          }
        } else {
          const baseHeaders = mergeHeaders(job.source.headers)
          // A named core keeps the blocks earlier attempts wrote; the factory is handed that byte offset and asks the
          // source for the rest, so a restart costs one Range request instead of the whole film again.
          const meta = {
            id: job.id,
            title: job.title,
            expectedSize: job.total,
            private: Boolean(job.private),
            store: job.store,
            hashState: job.hashState || null,
            hashBytes: job.hashBytes || 0,
            // The running sha256 state rides in the job: a restart folds a small gap in instead of re-reading the film.
            onHashState (state, bytes) {
              job.hashState = b4a.toString(state, 'base64')
              job.hashBytes = bytes
              save()
            },
            ...(job.private && job.storeKey ? { storeKey: job.storeKey } : {})
          }
          op = await node.put(meta, async start => {
            const resumeHeaders = start > 0
              ? { ...baseHeaders, range: `bytes=${start}-`, ...(job.etag || job.lastModified ? { 'if-range': job.etag || job.lastModified } : {}) }
              : baseHeaders
            const first = await openSource(job.source.url, resumeHeaders, controller)
            if (start > 0) {
              const m = String(first.headers['content-range'] || '').match(/^bytes\s+(\d+)-/i)
              // The bytes on disk only belong to this film if the source still serves the same file from that offset;
              // a rotated ETag means a different encode, and stitching two encodes would make a corrupt film.
              const rotated = job.etag && typeof first.headers.etag === 'string' && first.headers.etag !== job.etag
              if (rotated || first.statusCode !== 206 || !m || Number(m[1]) !== start) {
                // Nothing reads this body: left open, it holds the connection, and the source keeps sending into it.
                first.destroy()
                throw Object.assign(new Error(`Source changed while resuming ${job.id}`), { restart: true })
              }
              job.bytes = start
            } else {
              const cl = Number(first.headers['content-length'])
              job.total = Number.isSafeInteger(cl) && cl >= 0 ? cl : null
              job.bytes = 0
              // Strong validators only: a weak ETag (`W/`) cannot prove two halves are the same bytes.
              job.etag = typeof first.headers.etag === 'string' && !first.headers.etag.startsWith('W/') ? first.headers.etag : null
              job.lastModified = typeof first.headers['last-modified'] === 'string' ? first.headers['last-modified'] : null
              // Durable at once: a crash before the first hash checkpoint resumes with the size and validator it saw.
              save()
            }
            meta.expectedSize = job.total
            return readResumable(job, job.source.url, baseHeaders, first, job.total, controller, start)
          }, bytes => { job.bytes = bytes })
        }
        if (job.status === 'cancelled') throw new Error('Cancelled')
        // Closed for a reopen: the next acquirer runs this job again from jobs.json, so this one must not announce it.
        if (closed) throw new Error('Closed')
        Object.assign(job, { status: 'announcing', announce: op, source: null })
        save()
      }
      await node.append(job.announce)
      Object.assign(job, { status: 'done', size: job.announce.size, sha256: job.announce.sha256, hashState: null, hashBytes: 0 })
      onDone?.(publicJob(job), job.announce)
    } catch (err) {
      if (job.status !== 'cancelled') job.status = job.announce ? 'announcing' : 'failed'
      job.error = err.message
      if (!closed && job.status === 'failed') {
        job.attempts = (job.attempts || 0) + 1
        // Dead-letter 401/403/404/410 sources once instead of choking concurrency slots forever.
        if (TERMINAL_STATUS.has(err.status) || job.attempts >= maxAttempts) job.source = null
      }
      // A job that will never run again must not leave a half-written core sitting on the array, nor a copy kept.
      if (job.status === 'cancelled' || (job.status === 'failed' && !job.source)) {
        if (job.store) node.dropStore?.(job.store)?.catch?.(() => {})
        if (job.existing && !job.announce) node.keepCopy(job.existing.blobs, false)
      }
      if (!closed && job.status === 'failed' && job.source && retryDelay > 0) {
        const delay = Math.min(err.retryAfter || retryDelay * 2 ** ((job.attempts || 1) - 1), 300_000)
        setTimeout(() => {
          if (job.status === 'failed' && !node.closing && !closed) {
            job.status = 'queued'
            save()
            next()
          }
        }, delay).unref?.()
      }
    }
    running.delete(job)
    save()
    if (!node.closing && !closed) next()
  }

  function next () {
    while (!closed && running.size < concurrency) {
      const job = jobs.find(j => !running.has(j) && j.status === 'announcing') || jobs.find(j => !running.has(j) && j.status === 'queued')
      if (!job) break
      run(job)
    }
  }
  // A 32-hex name per job: the Corestore key for that video is derived from it, so a restart reopens the same core.
  const newStore = () => `video:${randomUUID().replace(/-/g, '')}`

  function add ({ id, title, source, channel = defaultChannel, private: isPrivate = false, plugin = 'http-acquire', existing = null }) {
    if (typeof source?.url !== 'string' || !/^https?:\/\//.test(source.url)) throw new Error('source.url must be http(s)')
    const job = { jobId: randomUUID(), id, title, plugin, channel: Boolean(channel), private: Boolean(isPrivate || source.private), status: 'queued', created: Date.now(), store: newStore(), source: { url: source.url, headers: source.headers || {}, page: Boolean(source.page) } }
    // Public copies only: a private job encrypts its own core.
    if (existing && !job.private) job.existing = { key: existing.key || null, size: existing.size, sha256: existing.sha256, blobs: existing.blobs, blob: existing.blob }
    // Private media is encrypted with a per-video key; a resumed core must be reopened with the same one.
    if (job.private) job.storeKey = randomBytes(32).toString('hex')
    jobs.push(job)
    save()
    next()
    return publicJob(job)
  }

  // Cancels a queued or running job; a finished, failed or cancelled one is dismissed from the list.
  function cancel (jobId) {
    const job = jobs.find(j => j.jobId === jobId)
    if (!job) return null
    // A job that will never run again drops its half-written core here; a running one does it in `run()`'s catch.
    const drop = () => {
      if (job.store && !job.announce) node.dropStore?.(job.store)?.catch?.(() => {})
      if (job.existing && !job.announce) node.keepCopy(job.existing.blobs, false)
    }
    if (job.status === 'queued' || job.status === 'running' || job.status === 'copying') {
      const controller = running.get(job)
      job.status = 'cancelled'
      job.source = null
      controller?.abort()
      save()
      if (!controller) drop()
    } else if (job.status !== 'announcing') {
      jobs = jobs.filter(j => j !== job)
      job.status = 'removed'
      save()
      drop()
    }
    return publicJob(job)
  }

  function repointBlob (oldTag, target) {
    let updated = 0
    for (const job of jobs) {
      if (job.announce && `${job.announce.blobs}:${job.announce.blob?.blockOffset}` === oldTag) {
        job.announce = { ...job.announce, blobs: target.blobs, blob: target.blob }
        updated++
      }
    }
    if (updated > 0) save()
    return updated
  }

  next()
  return {
    add,
    cancel,
    repointBlob,
    get: jobId => { const job = jobs.find(j => j.jobId === jobId); return job ? publicJob(job) : null },
    list: () => jobs.map(publicJob),
    setConcurrency (n) {
      concurrency = n
      next()
    },
    close () {
      save()
      closed = true
      for (const controller of running.values()) controller.abort()
    }
  }
}
