import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'streamx'
import { resolvePage } from './identify.js'

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
export function createAcquirer (node, file, {
  concurrency = Number(process.env.PEARTUBE_ACQUIRE_CONCURRENCY || 4),
  retryDelay = 15_000,
  stallTimeout = 30_000,
  maxReconnects = 8,
  maxAttempts = 4,
  defaultChannel = Boolean(process.env.PEARTUBE_PUBLISH_CHANNEL),
  onDone = null
} = {}) {
  let jobs = []
  try { jobs = JSON.parse(readFileSync(file, 'utf8')) } catch {}
  for (const job of jobs) {
    if (job.status === 'running' || (job.status === 'failed' && job.source)) {
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

  // Public view of a job: strip raw source secrets and internal announce payloads clean.
  const view = ({ source, announce, ...job }) => job

  function openSource (url, headers, controller, redirects = 0, timeout = stallTimeout) {
    return new Promise((resolve, reject) => {
      if (controller.aborted) return reject(new Error('Cancelled'))
      const parsed = new URL(url)
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
      const req = fn(parsed, { headers }, res => {
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
          const retryAfter = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0
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
  function readResumable (job, url, baseHeaders, first, total, controller) {
    const etag = typeof first.headers.etag === 'string' && !first.headers.etag.startsWith('W/') ? first.headers.etag : null
    return Readable.from((async function * () {
      let cur = first
      let offset = 0
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
          if (total === null || offset >= total) return
        } catch (err) {
          if (controller.aborted || closed) throw new Error('Cancelled')
          if (total === null || offset === 0) throw err
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

  // A job is spent only once its announce is durable; save the stored blob's announce immediately after put()
  // without triggering foreign-cache GC so a restart re-announces instead of orphaning the core and re-fetching.
  async function run (job) {
    job.status = job.announce ? 'announcing' : 'running'
    job.error = null
    save()
    const controller = { aborted: false, onabort: null, abort () { this.aborted = true; this.onabort?.() } }
    running.set(job, controller)
    try {
      if (!job.announce) {
        // A page link (YouTube, …) is resolved to its media file on every attempt: those URLs expire.
        const media = job.source.page ? await resolvePage(job.source.url) : { url: job.source.url, headers: {} }
        if (job.status === 'cancelled') throw new Error('Cancelled')
        const baseHeaders = mergeHeaders(media.headers, job.source.headers)
        const first = await openSource(media.url, baseHeaders, controller)
        const cl = Number(first.headers['content-length'])
        job.total = Number.isSafeInteger(cl) && cl >= 0 ? cl : null
        job.bytes = 0
        const stream = readResumable(job, media.url, baseHeaders, first, job.total, controller)
        const op = await node.put({ id: job.id, title: job.title, expectedSize: job.total }, stream, bytes => { job.bytes = bytes })
        if (job.status === 'cancelled') throw new Error('Cancelled')
        // Closed for a reopen: the next acquirer runs this job again from jobs.json, so this one must not announce it.
        if (closed) throw new Error('Closed')
        Object.assign(job, { status: 'announcing', announce: op, source: null })
        save()
      }
      await node.append(job.announce)
      if (job.channel ?? defaultChannel) await node.publishChannel?.(job.announce)
      Object.assign(job, { status: 'done', size: job.announce.size, sha256: job.announce.sha256 })
      onDone?.(view(job), job.announce)
    } catch (err) {
      if (job.status !== 'cancelled') job.status = job.announce ? 'announcing' : 'failed'
      job.error = err.message
      if (!closed && job.status === 'failed') {
        job.attempts = (job.attempts || 0) + 1
        // Dead-letter 401/403/404/410 sources once instead of choking concurrency slots forever.
        if (TERMINAL_STATUS.has(err.status) || job.attempts >= maxAttempts) job.source = null
      }
      if (!closed && job.status === 'failed' && job.source && retryDelay > 0) {
        const delay = err.retryAfter || Math.min(retryDelay * 2 ** ((job.attempts || 1) - 1), 300_000)
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
  function add ({ id, title, source, channel = defaultChannel, plugin = 'http-acquire' }) {
    if (typeof source?.url !== 'string' || !/^https?:\/\//.test(source.url)) throw new Error('source.url must be http(s)')
    const job = { jobId: randomUUID(), id, title, plugin, channel: Boolean(channel), status: 'queued', created: Date.now(), source: { url: source.url, headers: source.headers || {}, page: Boolean(source.page) } }
    jobs.push(job)
    save()
    next()
    return view(job)
  }

  // Cancels a queued or running job; a finished, failed or cancelled one is dismissed from the list.
  function cancel (jobId) {
    const job = jobs.find(j => j.jobId === jobId)
    if (!job) return null
    if (job.status === 'queued' || job.status === 'running') {
      job.status = 'cancelled'
      job.source = null
      running.get(job)?.abort()
      save()
    } else if (job.status !== 'announcing') {
      jobs = jobs.filter(j => j !== job)
      job.status = 'removed'
      save()
    }
    return view(job)
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
    get: jobId => { const job = jobs.find(j => j.jobId === jobId); return job ? view(job) : null },
    list: () => jobs.map(view),
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
