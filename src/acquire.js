import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

// Jobs hold source URLs and auth headers, so they live in a private file and
// never in the Corestore: replication serves any stored core a peer can name.
export function createAcquirer (node, file) {
  let jobs = []
  try { jobs = JSON.parse(readFileSync(file, 'utf8')) } catch {}
  for (const job of jobs) if (job.status === 'running') job.status = job.announce ? 'announcing' : 'queued'
  let running = null

  function save () {
    writeFileSync(file + '.tmp', JSON.stringify(jobs), { mode: 0o600 })
    renameSync(file + '.tmp', file)
  }

  // Public view of a job: never the source.
  const view = ({ source, announce, ...job }) => job

  // A job is done only once its announce is durable. The stored blob's
  // announce is saved first, so a restart re-announces instead of re-fetching.
  async function run (job) {
    job.status = job.announce ? 'announcing' : 'running'
    job.error = null
    save()
    const controller = new AbortController()
    running = { job, controller }
    try {
      if (!job.announce) {
        const res = await fetch(job.source.url, { headers: job.source.headers || {}, signal: controller.signal })
        if (!res.ok || !res.body) throw new Error(`Source answered ${res.status}`)
        job.total = Number(res.headers.get('content-length')) || null
        job.bytes = 0
        const op = await node.put({ id: job.id, title: job.title }, Readable.fromWeb(res.body), bytes => { job.bytes = bytes })
        if (job.status === 'cancelled') throw new Error('Cancelled')
        Object.assign(job, { status: 'announcing', announce: op, source: null })
        save()
      }
      await node.append(job.announce)
      Object.assign(job, { status: 'done', size: job.announce.size, sha256: job.announce.sha256 })
    } catch (err) {
      if (job.status !== 'cancelled') job.status = job.announce ? 'announcing' : 'failed'
      job.error = err.message
    }
    running = null
    save()
    if (!node.closing) next()
  }

  function next () {
    if (running) return
    const job = jobs.find(j => j.status === 'announcing') || jobs.find(j => j.status === 'queued')
    if (job) run(job)
  }

  function add ({ id, title, source }) {
    if (typeof source?.url !== 'string' || !/^https?:\/\//.test(source.url)) throw new Error('source.url must be http(s)')
    const job = { jobId: randomUUID(), id, title, status: 'queued', created: Date.now(), source: { url: source.url, headers: source.headers || {} } }
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
      if (running?.job === job) running.controller.abort()
      save()
    }
    return view(job)
  }

  next()
  return {
    add,
    cancel,
    get: jobId => { const job = jobs.find(j => j.jobId === jobId); return job ? view(job) : null },
    list: () => jobs.map(view)
  }
}
