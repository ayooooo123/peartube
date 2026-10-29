import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

// Jobs hold source URLs and auth headers, so they live in a private file and
// never in the Corestore: replication serves any stored core a peer can name.
export function createAcquirer (node, file, {
  concurrency = Number(process.env.PEARTUBE_ACQUIRE_CONCURRENCY || 4),
  retryDelay = 15_000,
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

  function save () {
    writeFileSync(file + '.tmp', JSON.stringify(jobs), { mode: 0o600 })
    renameSync(file + '.tmp', file)
  }

  // Public view of a job: never the source.
  const view = ({ source, announce, ...job }) => job

  function openSource (url, headers, controller, redirects = 0) {
    return new Promise((resolve, reject) => {
      if (controller.aborted) return reject(new Error('Cancelled'))
      const parsed = new URL(url)
      const fn = parsed.protocol === 'https:' ? httpsRequest : httpRequest
      const req = fn(parsed, { headers }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
          res.resume?.()
          const target = new URL(res.headers.location, parsed)
          // Like fetch: credentials never follow a redirect to another origin.
          const next = target.origin === parsed.origin
            ? headers
            : Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(authorization|cookie|proxy-authorization)$/i.test(k)))
          resolve(openSource(target.href, next, controller, redirects + 1))
          return
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume?.()
          reject(new Error(`Source answered ${res.statusCode}`))
          return
        }
        resolve(res)
      })
      const abort = () => req.destroy(new Error('Cancelled'))
      controller.onabort = abort
      // After a redirect the next request owns onabort; don't clear it from here.
      req.once('close', () => { if (controller.onabort === abort) controller.onabort = null })
      req.once('error', reject)
      req.end()
    })
  }

  // A job is done only once its announce is durable. The stored blob's
  // announce is saved first, so a restart re-announces instead of re-fetching.
  async function run (job) {
    job.status = job.announce ? 'announcing' : 'running'
    job.error = null
    save()
    const controller = { aborted: false, onabort: null, abort () { this.aborted = true; this.onabort?.() } }
    running.set(job, controller)
    try {
      if (!job.announce) {
        const res = await openSource(job.source.url, job.source.headers || {}, controller)
        const cl = Number(res.headers['content-length'])
        job.total = Number.isSafeInteger(cl) && cl >= 0 ? cl : null
        job.bytes = 0
        const op = await node.put({ id: job.id, title: job.title, expectedSize: job.total }, res, bytes => { job.bytes = bytes })
        if (job.status === 'cancelled') throw new Error('Cancelled')
        await node.clearCache?.().catch(() => {})
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
      if (job.status === 'failed' && job.source && retryDelay > 0) {
        setTimeout(() => {
          if (job.status === 'failed' && !node.closing) {
            job.status = 'queued'
            save()
            next()
          }
        }, retryDelay).unref?.()
      }
    }
    running.delete(job)
    save()
    if (!node.closing) next()
  }

  function next () {
    while (running.size < concurrency) {
      const job = jobs.find(j => !running.has(j) && j.status === 'announcing') || jobs.find(j => !running.has(j) && j.status === 'queued')
      if (!job) break
      run(job)
    }
  }
  function add ({ id, title, source, channel = defaultChannel, plugin = 'http-acquire' }) {
    if (typeof source?.url !== 'string' || !/^https?:\/\//.test(source.url)) throw new Error('source.url must be http(s)')
    const job = { jobId: randomUUID(), id, title, plugin, channel: Boolean(channel), status: 'queued', created: Date.now(), source: { url: source.url, headers: source.headers || {} } }
    jobs.push(job)
    save()
    next()
    return view(job)
  }

  function cancel (jobId) {
    const job = jobs.find(j => j.jobId === jobId)
    if (!job) return null
    if (job.status === 'queued' || job.status === 'running') {
      job.status = 'cancelled'
      job.source = null
      running.get(job)?.abort()
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
    list: () => jobs.map(view)
  }
}
