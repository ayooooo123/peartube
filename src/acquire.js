import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

// Jobs hold source URLs and auth headers, so they live in a private file and
// never in the Corestore: replication serves any stored core a peer can name.
export function createAcquirer (node, file) {
  let jobs = []
  try { jobs = JSON.parse(readFileSync(file, 'utf8')) } catch {}
  for (const job of jobs) if (job.status === 'running') job.status = 'queued'
  let running = null

  function save () {
    writeFileSync(file + '.tmp', JSON.stringify(jobs), { mode: 0o600 })
    renameSync(file + '.tmp', file)
  }

  // Public view of a job: never the source.
  const view = ({ source, ...job }) => job

  async function run (job) {
    job.status = 'running'
    job.error = null
    save()
    const controller = new AbortController()
    running = { job, controller }
    try {
      const res = await fetch(job.source.url, { headers: job.source.headers || {}, signal: controller.signal })
      if (!res.ok || !res.body) throw new Error(`Source answered ${res.status}`)
      const result = await node.publish({ id: job.id, title: job.title }, Readable.fromWeb(res.body))
      Object.assign(job, { status: 'done', size: result.size, sha256: result.sha256, source: null })
    } catch (err) {
      job.status = job.status === 'cancelled' ? 'cancelled' : 'failed'
      job.error = err.message
    }
    running = null
    save()
    next()
  }

  function next () {
    if (running) return
    const job = jobs.find(j => j.status === 'queued')
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
