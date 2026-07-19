import b4a from 'b4a'
import merkleTree from 'hypercore/lib/merkle-tree.js'

import { SEED_PIN_ERROR_CODES } from './protocol.js'
const { MerkleTree } = merkleTree

const HEX_32 = /^[0-9a-f]{64}$/
const DEFAULT_CONCURRENCY = 2
const DEFAULT_QUEUE_LIMIT = 256
const DEFAULT_RANGE_TIMEOUT = 30_000
const DEFAULT_DOWNLOAD_TIMEOUT = 5 * 60_000
const DEFAULT_RELEASE_TIMEOUT = 30_000
const DEFAULT_PROGRESS_CHUNK_BLOCKS = 64
const DEFAULT_MAX_BLOCKS_PER_REQUEST = 1_000_000
const DEFAULT_IDLE_TIMEOUT = 30_000
const MAX_TIMER_DELAY = 0x7fffffff
export const MAX_PIN_WORKER_CONCURRENCY = 64
const MAX_QUEUE_LIMIT = 1024
const RESUMABLE_STATES = new Set(['accepted', 'pinning', 'retryable'])
const ACTIVE_STATES = new Set([...RESUMABLE_STATES, 'complete'])

export class PinWorkerError extends Error {
  constructor (message, code = SEED_PIN_ERROR_CODES.INTERNAL) {
    super(message)
    this.name = 'PinWorkerError'
    this.code = code
  }
}

class WorkerFault extends Error {
  constructor (reason, {
    state = 'retryable',
    errorCode = SEED_PIN_ERROR_CODES.WORKER_UNAVAILABLE,
    cleanup = false,
  } = {}) {
    super(reason)
    this.name = 'WorkerFault'
    this.reason = reason
    this.state = state
    this.errorCode = errorCode
    this.cleanup = cleanup
  }
}

export class PinWorker {
  constructor ({
    corestore,
    pinStore,
    concurrency = DEFAULT_CONCURRENCY,
    queueLimit = DEFAULT_QUEUE_LIMIT,
    capacityPolicy = allow,
    releasePolicy = deny,
    rangeTimeout = DEFAULT_RANGE_TIMEOUT,
    downloadTimeout = DEFAULT_DOWNLOAD_TIMEOUT,
    releaseTimeout = DEFAULT_RELEASE_TIMEOUT,
    progressChunkBlocks = DEFAULT_PROGRESS_CHUNK_BLOCKS,
    maxBlocksPerRequest = DEFAULT_MAX_BLOCKS_PER_REQUEST,
    now = Date.now,
  } = {}) {
    if (!corestore || typeof corestore.session !== 'function') {
      throw new TypeError('corestore must provide session()')
    }
    if (!pinStore || typeof pinStore.getByRequestId !== 'function' ||
        typeof pinStore.listResumable !== 'function' ||
        typeof pinStore.listActive !== 'function' ||
        typeof pinStore.reopenCompleteForRepair !== 'function' ||
        typeof pinStore.reserveWorkerCapacity !== 'function' ||
        typeof pinStore.updateWorkerStatus !== 'function') {
      throw new TypeError(
        'pinStore must provide getByRequestId, listResumable, listActive, ' +
        'reopenCompleteForRepair, reserveWorkerCapacity, and updateWorkerStatus',
      )
    }
    this.concurrency = boundedInteger(concurrency, 'concurrency', MAX_PIN_WORKER_CONCURRENCY)
    this.queueLimit = boundedInteger(queueLimit, 'queueLimit', MAX_QUEUE_LIMIT)
    this.rangeTimeout = boundedInteger(rangeTimeout, 'rangeTimeout', MAX_TIMER_DELAY)
    this.downloadTimeout = boundedInteger(downloadTimeout, 'downloadTimeout', MAX_TIMER_DELAY)
    this.releaseTimeout = boundedInteger(releaseTimeout, 'releaseTimeout', MAX_TIMER_DELAY)
    this.progressChunkBlocks = boundedInteger(
      progressChunkBlocks,
      'progressChunkBlocks',
      Number.MAX_SAFE_INTEGER,
    )
    this.maxBlocksPerRequest = boundedInteger(
      maxBlocksPerRequest,
      'maxBlocksPerRequest',
      Number.MAX_SAFE_INTEGER,
    )
    if (typeof capacityPolicy !== 'function') throw new TypeError('capacityPolicy must be a function')
    if (typeof releasePolicy !== 'function') throw new TypeError('releasePolicy must be a function')
    if (typeof now !== 'function') throw new TypeError('now must be a function')

    this.corestore = corestore
    this.pinStore = pinStore
    this.capacityPolicy = capacityPolicy
    this.releasePolicy = releasePolicy
    this.now = now
    this.queue = []
    this.capacityWaiters = new Set()
    this.resumeTask = null
    this.resumeInitial = null
    this.resumeStats = null
    this.resumeError = null
    this.jobs = new Map()
    this.retentions = new Map()
    this.active = 0
    this.stopped = false
    this.stopping = false
    this.idleWaiters = new Set()
    this.lifecycleListeners = new Set()
    this.pendingCapacityReleases = new Set()
    this.completedCapacityReleases = new Set()
    this.capacityReleaseTasks = new Map()
    this.capacityReleaseError = null
  }

  async start (requestId) {
    const id = normalizeRequestId(requestId)
    if (this.stopped) throw new PinWorkerError('seed pin worker is stopped', SEED_PIN_ERROR_CODES.WORKER_UNAVAILABLE)
    if (this.jobs.has(id)) return { outcome: 'matched', requestId: id }

    const record = await this.pinStore.getByRequestId(id)
    if (record === null) throw new PinWorkerError('seed pin request not found', SEED_PIN_ERROR_CODES.NOT_FOUND)
    if (this.stopped) throw new PinWorkerError('seed pin worker is stopped', SEED_PIN_ERROR_CODES.WORKER_UNAVAILABLE)
    if (this.jobs.has(id)) return { outcome: 'matched', requestId: id }
    if (record.status.state === 'complete' && this.retentions.has(id)) {
      return { outcome: 'complete', requestId: id }
    }
    if (!ACTIVE_STATES.has(record.status.state)) {
      return { outcome: 'ignored', requestId: id, state: record.status.state }
    }
    if (this.active >= this.concurrency && this.queue.length >= this.queueLimit) {
      throw new PinWorkerError('seed pin worker queue is busy', SEED_PIN_ERROR_CODES.BUSY)
    }

    const job = {
      requestId: id,
      record,
      stage: 'queued',
      cancelled: false,
      stopping: false,
      abortListeners: new Set(),
      promise: null,
    }
    this.jobs.set(id, job)
    this.queue.push(job)
    this._drain()
    return { outcome: 'scheduled', requestId: id }
  }

  async resume () {
    if (this.stopped) throw new PinWorkerError('seed pin worker is stopped', SEED_PIN_ERROR_CODES.WORKER_UNAVAILABLE)
    if (this.resumeError !== null) {
      const error = this.resumeError
      this.resumeError = null
      throw error
    }
    if (this.resumeTask !== null) {
      await this.resumeInitial.promise
      return { ...this.resumeStats }
    }

    const initial = createDeferred()
    const stats = { scheduled: 0, matched: 0, busy: 0 }
    this.resumeInitial = initial
    this.resumeStats = stats
    const feeder = this._feedActive(stats, initial)
    const owned = feeder.then(
      noop,
      error => {
        if (!initial.settled) initial.reject(error)
        else if (!this.stopped) this.resumeError = error
      },
    ).finally(() => {
      if (!initial.settled) initial.resolve()
      if (this.resumeTask === owned) {
        this.resumeTask = null
        this.resumeInitial = null
        this.resumeStats = null
      }
      this._notifyIdle()
    })
    this.resumeTask = owned
    await initial.promise
    return { ...stats }
  }

  async _feedActive (stats, initial) {
    let cursor = null
    let firstFetchedPage = true
    let corruption = null
    const pageLimit = this.queueLimit + this.concurrency
    do {
      if (this.stopped) {
        throw new PinWorkerError('seed pin worker is stopped', SEED_PIN_ERROR_CODES.WORKER_UNAVAILABLE)
      }
      const page = await this.pinStore.listActive({ limit: pageLimit, cursor })
      const pageError = page?.error || null
      if (!page || !Array.isArray(page.records) ||
          (page.cursor !== null && !isBoundedActiveCursor(page.cursor)) ||
          (pageError !== null && (typeof pageError.message !== 'string' || page.cursor === null)) ||
          (page.cursor !== null && page.cursor === cursor)) {
        throw new PinWorkerError('pinStore returned a malformed active page')
      }
      for (const record of page.records) {
        while (true) {
          if (firstFetchedPage && !initial.settled && this._queueIsFull()) initial.resolve()
          if (!(await this._waitForQueueCapacity())) return
          try {
            const result = await this.start(record.requestId)
            if (result.outcome === 'scheduled') stats.scheduled++
            else stats.matched++
            if (firstFetchedPage && !initial.settled && this._queueIsFull()) initial.resolve()
            break
          } catch (error) {
            if (error?.code !== SEED_PIN_ERROR_CODES.BUSY) throw error
          }
        }
      }
      if (firstFetchedPage) {
        firstFetchedPage = false
        if (!initial.settled) initial.resolve()
      }
      if (pageError !== null && corruption === null) corruption = pageError
      cursor = page.cursor
    } while (cursor !== null)
    if (!initial.settled) initial.resolve()
    if (corruption !== null) throw corruption
  }

  _queueIsFull () {
    return this.active >= this.concurrency && this.queue.length >= this.queueLimit
  }

  async _waitForQueueCapacity () {
    while (!this.stopped && this.active >= this.concurrency &&
        this.queue.length >= this.queueLimit) {
      await new Promise(resolve => this.capacityWaiters.add(resolve))
    }
    return !this.stopped
  }

  async release (requestId, options = {}) {
    return this._release(requestId, 'released', options)
  }

  async cancel (requestId, options = {}) {
    return this._release(requestId, 'cancelled', options)
  }

  async waitForIdle ({ timeout = DEFAULT_IDLE_TIMEOUT } = {}) {
    boundedInteger(timeout, 'timeout', MAX_TIMER_DELAY)
    if (this.active === 0 && this.queue.length === 0 && this.resumeTask === null) {
      if (this.resumeError !== null) throw this.resumeError
      return
    }
    await new Promise((resolve, reject) => {
      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.idleWaiters.delete(finish)
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(() => {
        finish(new PinWorkerError('timed out waiting for seed pin worker idle'))
      }, timeout)
      this.idleWaiters.add(finish)
    })
  }

  async stop () {
    if (this.stopping) {
      if (this.resumeTask) await this.resumeTask
      await this.waitForIdle().catch(() => {})
      return
    }
    if (this.stopped) return
    this.stopping = true
    this.stopped = true
    const resumeTask = this.resumeTask
    this._notifyCapacity()
    this._interruptLifecycle(new WorkerFault('worker-stopped'))

    const queued = this.queue.splice(0)
    for (const job of queued) this.jobs.delete(job.requestId)
    const running = []
    for (const job of this.jobs.values()) {
      if (job.stage !== 'running') continue
      job.stopping = true
      this._interrupt(job, new WorkerFault('worker-stopped'))
      const retention = this.retentions.get(job.requestId)
      if (retention) destroyDownloads(retention)
      if (job.promise) running.push(job.promise)
    }
    await Promise.allSettled(running)
    if (resumeTask) await resumeTask
    for (const [requestId, retention] of this.retentions) {
      await closeRetention(retention)
      this.retentions.delete(requestId)
    }
    this.stopping = false
    this._notifyCapacity()
    this._notifyIdle()
  }

  _drain () {
    if (this.stopped) return
    while (this.active < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()
      if (job.cancelled) {
        this.jobs.delete(job.requestId)
        this._notifyCapacity()
        continue
      }
      job.stage = 'running'
      this.active++
      job.promise = this._execute(job)
      void job.promise.then(noop, noop).finally(() => {
        this.active--
        if (this.jobs.get(job.requestId) === job) this.jobs.delete(job.requestId)
        this._notifyCapacity()
        this._drain()
        this._notifyIdle()
      })
    }
    this._notifyCapacity()
    this._notifyIdle()
  }

  async _execute (job) {
    let retention = null
    try {
      const current = await this.pinStore.getByRequestId(job.requestId)
      if (current === null || !ACTIVE_STATES.has(current.status.state)) return
      job.record = current
      const restoreVerification = current.status.state === 'complete'
      let repairing = false

      const totalBlocks = countUniqueBlocks(current.manifest.refs)
      const traversalBlocks = countTraversedBlocks(current.manifest.refs)
      if (totalBlocks === null || traversalBlocks === null ||
          totalBlocks > this.maxBlocksPerRequest ||
          traversalBlocks > this.maxBlocksPerRequest) {
        throw new WorkerFault('capacity', {
          state: 'failed',
          errorCode: SEED_PIN_ERROR_CODES.CAPACITY_EXCEEDED,
        })
      }
      const estimateAllowed = await runJobOperation(
        job,
        Promise.resolve().then(() => this._runCapacityPolicy(Object.freeze({
          phase: 'estimate',
          requestId: job.requestId,
          manifest: cloneManifest(current.manifest),
          refs: current.manifest.refs.map(ref => Object.freeze({ ...ref })),
          totalBlocks,
          traversalBlocks,
          knownBytes: current.progress.downloadedBytes,
          downloadedBlocks: current.progress.downloadedBlocks,
          downloadedBytes: current.progress.downloadedBytes,
          persistedReservedBytes: current.progress.reservedBytes,
          persistedDownloadedBytes: current.progress.downloadedBytes,
          persistedUsageBytes: Math.max(current.progress.reservedBytes, current.progress.downloadedBytes),
        }))),
        this.downloadTimeout,
        () => new WorkerFault('capacity-policy'),
      )
      this._throwIfInterrupted(job)
      if (estimateAllowed !== true) {
        throw new WorkerFault('capacity', {
          state: 'failed',
          errorCode: SEED_PIN_ERROR_CODES.CAPACITY_EXCEEDED,
        })
      }

      if (!restoreVerification) job.record = await this._setPinning(job.record)
      this._throwIfInterrupted(job)
      let session
      try {
        session = this.corestore.session()
      } catch {
        throw new WorkerFault('open', { cleanup: true })
      }
      if (!session || typeof session.get !== 'function' || typeof session.close !== 'function') {
        if (session && typeof session.close === 'function') await session.close().catch(() => {})
        throw new WorkerFault('open', { cleanup: true })
      }
      retention = {
        session,
        cores: new Map(),
        downloads: new Set(),
        downloadsDestroyed: false,
        closed: false,
      }
      this.retentions.set(job.requestId, retention)
      this._throwIfInterrupted(job)
      job.record = await this._preflightCapacity(job, retention, totalBlocks)
      this._throwIfInterrupted(job)

      let downloadedBlocks = 0
      let downloadedBytes = 0
      const accountedEnds = new Map()
      const verifiedRefs = job.record.status.refs.map(ref => ({ ...ref }))
      for (let refIndex = 0; refIndex < job.record.manifest.refs.length; refIndex++) {
        this._throwIfInterrupted(job)
        const ref = job.record.manifest.refs[refIndex]
        const core = await this._openCore(job, retention, ref.coreKey)

        let locallyComplete = false
        if (restoreVerification && Number.isSafeInteger(core.length) && core.length >= ref.end) {
          locallyComplete = await this._rangeIsLocal(job, core, ref)
        }
        if (restoreVerification && !locallyComplete && !repairing) {
          job.record = await this.pinStore.reopenCompleteForRepair({
            requestId: job.requestId,
            refIndex,
            updatedAt: this._now(),
          })
          repairing = true
          this._throwIfInterrupted(job)
        }

        if (!locallyComplete) {
          await this._waitForRange(job, core, ref.end)
          this._throwIfInterrupted(job)
          let download
          try {
            download = core.download({ start: ref.start, end: ref.end, linear: true })
            if (!download || typeof download.done !== 'function') throw new Error('invalid download handle')
          } catch {
            throw new WorkerFault('download')
          }
          retention.downloads.add(download)
          try {
            await runJobOperation(
              job,
              download.done(),
              this.downloadTimeout,
              () => {
                destroyDownload(download)
                return new WorkerFault('download')
              },
            )
          } catch (error) {
            this._throwIfInterrupted(job)
            if (error instanceof WorkerFault) throw error
            throw new WorkerFault('download')
          }
          this._throwIfInterrupted(job)
        }

        let refBytes = 0
        const previouslyAccountedEnd = accountedEnds.get(ref.coreKey) ?? -1
        for (let index = ref.start; index < ref.end; index++) {
          this._throwIfInterrupted(job)
          let local
          try {
            local = await runJobOperation(
              job,
              Promise.resolve().then(() => core.has(index)),
              this.rangeTimeout,
              () => new WorkerFault('local-missing'),
            )
          } catch (error) {
            this._throwIfInterrupted(job)
            if (error instanceof WorkerFault) throw error
            throw new WorkerFault('local-missing')
          }
          if (local !== true) throw new WorkerFault('local-missing')
          let block
          try {
            block = await runJobOperation(
              job,
              Promise.resolve().then(() => core.get(index, { wait: false })),
              this.rangeTimeout,
              () => new WorkerFault('local-missing'),
            )
          } catch (error) {
            this._throwIfInterrupted(job)
            if (error instanceof WorkerFault) throw error
            throw new WorkerFault('corrupt', {
              state: 'failed',
              errorCode: SEED_PIN_ERROR_CODES.INTERNAL,
            })
          }
          if (!(block instanceof Uint8Array) && !b4a.isBuffer(block)) {
            throw new WorkerFault('local-missing')
          }
          refBytes = safeAdd(refBytes, block.byteLength, 'capacity')
          if (index >= previouslyAccountedEnd) {
            downloadedBlocks = safeAdd(downloadedBlocks, 1, 'capacity')
            downloadedBytes = safeAdd(downloadedBytes, block.byteLength, 'capacity')
          }

          const allowed = await runJobOperation(
            job,
            Promise.resolve().then(() => this._runCapacityPolicy(Object.freeze({
              phase: 'progress',
              requestId: job.requestId,
              manifest: cloneManifest(job.record.manifest),
              ref: Object.freeze({ ...ref }),
              refIndex,
              totalBlocks,
              knownBytes: downloadedBytes,
              downloadedBlocks,
              downloadedBytes,
              persistedReservedBytes: job.record.progress.reservedBytes,
              persistedDownloadedBytes: job.record.progress.downloadedBytes,
              persistedUsageBytes: Math.max(job.record.progress.reservedBytes, job.record.progress.downloadedBytes),
            }))),
            this.downloadTimeout,
            () => new WorkerFault('capacity-policy'),
          )
          this._throwIfInterrupted(job)
          if (allowed !== true) {
            throw new WorkerFault('quota', {
              state: 'failed',
              errorCode: SEED_PIN_ERROR_CODES.CAPACITY_EXCEEDED,
            })
          }

          const finalBlock = index + 1 === ref.end
          if (!restoreVerification || repairing) {
            if (finalBlock || ((index - ref.start + 1) % this.progressChunkBlocks === 0)) {
              job.record = await this._checkpoint(
                job.record,
                refIndex,
                refBytes,
                finalBlock,
                downloadedBlocks,
                downloadedBytes,
              )
            }
          }
          this._throwIfInterrupted(job)
        }
        verifiedRefs[refIndex] = {
          ...verifiedRefs[refIndex],
          state: 'complete',
          bytesPinned: Math.max(verifiedRefs[refIndex].bytesPinned, refBytes),
        }
        accountedEnds.set(ref.coreKey, Math.max(previouslyAccountedEnd, ref.end))
      }

      this._throwIfInterrupted(job)
      const refs = restoreVerification && !repairing ? verifiedRefs : job.record.status.refs
      if (refs.some(ref => ref.state !== 'complete')) throw new WorkerFault('local-missing')
      const completedAt = restoreVerification && !repairing
        ? job.record.status.completedAt
        : this._now()
      job.record = await this.pinStore.updateWorkerStatus({
        requestId: job.requestId,
        state: 'complete',
        refs,
        errorCode: null,
        error: null,
        completedAt,
        downloadedBlocks,
        downloadedBytes,
        updatedAt: this._now(),
      })
      await this._capacityPersisted(job.requestId)
    } catch (error) {
      if (retention) {
        await closeRetention(retention)
        if (this.retentions.get(job.requestId) === retention) this.retentions.delete(job.requestId)
      }
      if (job.cancelled) return
      let fault = error
      if (job.stopping || this.stopping) fault = new WorkerFault('worker-stopped')
      else if (!(fault instanceof WorkerFault)) fault = new WorkerFault('internal')
      try {
        const current = await this.pinStore.getByRequestId(job.requestId)
        if (current !== null && ACTIVE_STATES.has(current.status.state)) {
          const refs = markCurrentRefFailed(current.status.refs)
          job.record = await this.pinStore.updateWorkerStatus({
            requestId: job.requestId,
            state: fault.state,
            refs,
            errorCode: fault.errorCode,
            error: fault.reason,
            completedAt: null,
            downloadedBlocks: current.progress.downloadedBlocks,
            downloadedBytes: current.progress.downloadedBytes,
            updatedAt: this._now(),
          })
          if (fault.state === 'failed') {
            await this._releaseCapacityReservation(job.requestId)
          }
        }
      } catch {
        // The metadata store is authoritative. A failed checkpoint remains visible
        // as its last durable active state rather than being fabricated here.
      }
    }
  }

  async _runCapacityPolicy (context) {
    await this._retryPendingCapacityReleases()
    const allowed = await this.capacityPolicy(context)
    if (allowed === true && context.phase === 'reserve') {
      this.pendingCapacityReleases.delete(context.requestId)
      this.completedCapacityReleases.delete(context.requestId)
    }
    return allowed
  }

  async _capacityPersisted (requestId) {
    if (typeof this.capacityPolicy.persisted === 'function') {
      await this.capacityPolicy.persisted(requestId)
    }
  }

  async _retryPendingCapacityReleases () {
    for (const requestId of [...this.pendingCapacityReleases]) {
      await this._releaseCapacityReservation(requestId)
    }
  }

  _releaseCapacityReservation (requestId) {
    if (this.completedCapacityReleases.has(requestId)) return Promise.resolve(true)
    const existing = this.capacityReleaseTasks.get(requestId)
    if (existing) return existing
    const task = this._performCapacityRelease(requestId)
    this.capacityReleaseTasks.set(requestId, task)
    return task.finally(() => {
      if (this.capacityReleaseTasks.get(requestId) === task) {
        this.capacityReleaseTasks.delete(requestId)
      }
    })
  }

  async _performCapacityRelease (requestId) {
    if (typeof this.capacityPolicy.release !== 'function') return true
    try {
      await runBoundedOperation(
        Promise.resolve().then(() => this.capacityPolicy.release(requestId)),
        this.releaseTimeout,
      )
      this.pendingCapacityReleases.delete(requestId)
      this.completedCapacityReleases.add(requestId)
      if (this.pendingCapacityReleases.size === 0) this.capacityReleaseError = null
      return true
    } catch (error) {
      this.pendingCapacityReleases.add(requestId)
      this.capacityReleaseError = error instanceof Error
        ? error
        : new Error('seed pin capacity release failed')
      return false
    }
  }

  async _preflightCapacity (job, retention, totalBlocks) {
    const intervals = coalesceRefs(job.record.manifest.refs)
    let reservedBytes = 0
    for (const interval of intervals) {
      const core = await this._openCore(job, retention, interval.coreKey)
      await this._waitForRange(job, core, interval.end)
      const byteLength = await this._rangeByteLength(job, core, interval.start, interval.end)
      reservedBytes = safeAdd(reservedBytes, byteLength, 'capacity')
    }
    const allowed = await runJobOperation(
      job,
      Promise.resolve().then(() => this._runCapacityPolicy(Object.freeze({
        phase: 'reserve',
        requestId: job.requestId,
        manifest: cloneManifest(job.record.manifest),
        refs: job.record.manifest.refs.map(ref => Object.freeze({ ...ref })),
        totalBlocks,
        reservedBlocks: totalBlocks,
        reservedBytes,
        knownBytes: job.record.progress.downloadedBytes,
        downloadedBlocks: job.record.progress.downloadedBlocks,
        downloadedBytes: job.record.progress.downloadedBytes,
        persistedReservedBytes: job.record.progress.reservedBytes,
        persistedDownloadedBytes: job.record.progress.downloadedBytes,
        persistedUsageBytes: Math.max(job.record.progress.reservedBytes, job.record.progress.downloadedBytes),
      }))),
      this.downloadTimeout,
      () => new WorkerFault('capacity-policy'),
    )
    this._throwIfInterrupted(job)
    if (allowed !== true) {
      throw new WorkerFault('quota', {
        state: 'failed',
        errorCode: SEED_PIN_ERROR_CODES.CAPACITY_EXCEEDED,
      })
    }
    const updated = await this.pinStore.reserveWorkerCapacity({
      requestId: job.requestId,
      reservedBlocks: totalBlocks,
      reservedBytes,
      updatedAt: this._now(),
    })
    await this._capacityPersisted(job.requestId)
    return updated
  }

  async _openCore (job, retention, coreKey) {
    const existing = retention.cores.get(coreKey)
    if (existing) return existing
    let core
    try {
      core = retention.session.get({ key: b4a.from(coreKey, 'hex') })
      if (!core || typeof core.ready !== 'function' || typeof core.has !== 'function' ||
          typeof core.get !== 'function' || typeof core.download !== 'function') {
        throw new Error('invalid core')
      }
      await runJobOperation(
        job,
        Promise.resolve().then(() => core.ready()),
        this.rangeTimeout,
        () => new WorkerFault('open', { cleanup: true }),
      )
      this._throwIfInterrupted(job)
      if (core.key !== undefined && normalizeCoreKey(core.key) !== coreKey) {
        throw new Error('opened wrong core')
      }
    } catch (error) {
      if (error instanceof WorkerFault) throw error
      throw new WorkerFault('open', { cleanup: true })
    }
    retention.cores.set(coreKey, core)
    return core
  }

  async _rangeByteLength (job, core, start, end) {
    try {
      let byteLength
      if (typeof core.byteRange === 'function') {
        const range = await runJobOperation(
          job,
          Promise.resolve().then(() => core.byteRange(start, end)),
          this.rangeTimeout,
          () => capacityFault(),
        )
        byteLength = typeof range === 'number' ? range : range?.byteLength
      } else if (core.state) {
        let offsets
        let offsetsIncludePadding = true
        const deadline = Date.now() + this.rangeTimeout
        const metadataRemaining = deadline - Date.now()
        if (metadataRemaining <= 0) throw capacityFault()
        try {
          offsets = await runJobOperation(
            job,
            Promise.all([
              MerkleTree.byteOffset(core.state, 2 * start),
              MerkleTree.byteOffset(core.state, 2 * end),
            ]),
            metadataRemaining,
            () => capacityFault(),
          )
        } catch (error) {
          this._throwIfInterrupted(job)
          if (error instanceof WorkerFault || typeof core.seek !== 'function') throw error
          offsets = await Promise.all([
            this._seekByteOffset(job, core, start, deadline),
            this._seekByteOffset(job, core, end, deadline),
          ])
          // Hypercore seek offsets already exclude per-block encryption padding.
          offsetsIncludePadding = false
        }
        const padding = offsetsIncludePadding &&
          Number.isSafeInteger(core.padding) && core.padding >= 0
          ? core.padding
          : 0
        byteLength = offsets[1] - offsets[0] - (end - start) * padding
      }
      if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw capacityFault()
      return byteLength
    } catch (error) {
      this._throwIfInterrupted(job)
      if (error instanceof WorkerFault) throw error
      throw capacityFault()
    }
  }

  async _seekByteOffset (job, core, index, deadline = Date.now() + this.rangeTimeout) {
    const length = core.length
    const byteLength = core.byteLength
    if (!Number.isSafeInteger(length) || length < 0 ||
        !Number.isSafeInteger(byteLength) || byteLength < 0 ||
        !Number.isSafeInteger(index) || index < 0 || index > length) {
      throw capacityFault()
    }
    if (index === 0) return 0
    if (index === length) return byteLength
    if (byteLength === 0) return 0

    let lower = 0
    let upper = byteLength
    let candidateOffset = -1
    let candidate = null
    while (lower < upper) {
      this._throwIfInterrupted(job)
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw capacityFault()
      const offset = lower + Math.floor((upper - lower) / 2)
      const found = await runJobOperation(
        job,
        Promise.resolve().then(() => core.seek(offset, {
          wait: true,
          timeout: remaining,
        })),
        remaining,
        () => capacityFault(),
      )
      if (!Array.isArray(found) || !Number.isSafeInteger(found[0]) ||
          found[0] < 0 || found[0] > length ||
          !Number.isSafeInteger(found[1]) || found[1] < 0 || found[1] > offset) {
        throw capacityFault()
      }
      if (found[0] < index) {
        lower = offset + 1
      } else {
        upper = offset
        candidateOffset = offset
        candidate = found
      }
    }
    if (candidateOffset !== lower) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw capacityFault()
      candidate = await runJobOperation(
        job,
        Promise.resolve().then(() => core.seek(lower, {
          wait: true,
          timeout: remaining,
        })),
        remaining,
        () => capacityFault(),
      )
    }
    if (!Array.isArray(candidate) || !Number.isSafeInteger(candidate[0]) ||
        candidate[0] < index || candidate[0] > length ||
        !Number.isSafeInteger(candidate[1]) || candidate[1] < 0 ||
        candidate[1] > lower) {
      throw capacityFault()
    }
    const blockStart = lower - candidate[1]
    if (!Number.isSafeInteger(blockStart) || blockStart < 0 ||
        blockStart > byteLength) {
      throw capacityFault()
    }
    return blockStart
  }

  async _setPinning (record) {
    const refs = record.status.refs.map((ref, index) => ({
      ...ref,
      state: ref.state === 'complete' ? 'complete' : index === 0 ? 'pinning' : 'pending',
    }))
    const updatedAt = this._now()
    return this.pinStore.updateWorkerStatus({
      requestId: record.requestId,
      state: 'pinning',
      refs,
      errorCode: null,
      error: null,
      completedAt: null,
      downloadedBlocks: record.progress.downloadedBlocks,
      downloadedBytes: record.progress.downloadedBytes,
      updatedAt,
    })
  }

  async _checkpoint (record, refIndex, refBytes, complete, downloadedBlocks, downloadedBytes) {
    const refs = record.status.refs.map((ref, index) => {
      if (index < refIndex) return { ...ref, state: 'complete' }
      if (index === refIndex) {
        return {
          ...ref,
          state: complete ? 'complete' : 'pinning',
          bytesPinned: Math.max(ref.bytesPinned, refBytes),
        }
      }
      if (index === refIndex + 1 && complete) return { ...ref, state: 'pinning' }
      return { ...ref }
    })
    const updatedAt = this._now()
    const updated = await this.pinStore.updateWorkerStatus({
      requestId: record.requestId,
      state: 'pinning',
      refs,
      errorCode: null,
      error: null,
      completedAt: null,
      downloadedBlocks,
      downloadedBytes,
      updatedAt,
    })
    await this._capacityPersisted(record.requestId)
    return updated
  }

  async _rangeIsLocal (job, core, ref) {
    for (let index = ref.start; index < ref.end; index++) {
      let local
      try {
        local = await runJobOperation(
          job,
          Promise.resolve().then(() => core.has(index)),
          this.rangeTimeout,
          () => new WorkerFault('local-missing'),
        )
      } catch (error) {
        this._throwIfInterrupted(job)
        if (error instanceof WorkerFault) throw error
        return false
      }
      this._throwIfInterrupted(job)
      if (local !== true) return false
    }
    return true
  }

  async _waitForRange (job, core, end) {
    const deadline = Date.now() + this.rangeTimeout
    while (true) {
      const length = core.length
      if (!Number.isSafeInteger(length) || length < 0) {
        throw new WorkerFault('range-unavailable')
      }
      if (end <= length) return
      this._throwIfInterrupted(job)
      if (Date.now() >= deadline) throw new WorkerFault('range-unavailable')
      if (typeof core.update === 'function') {
        try {
          await runJobOperation(
            job,
            core.update({ wait: false }),
            Math.max(1, deadline - Date.now()),
            () => new WorkerFault('range-unavailable'),
          )
        } catch (error) {
          this._throwIfInterrupted(job)
          if (error instanceof WorkerFault && error.reason === 'range-unavailable') throw error
          // A later append can still make the range available before the deadline.
        }
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new WorkerFault('range-unavailable')
      await interruptibleDelay(job, Math.min(10, remaining))
    }
  }

  async _release (requestId, state, options) {
    const id = normalizeRequestId(requestId)
    if (this.stopped) {
      throw new PinWorkerError('seed pin worker is stopped', SEED_PIN_ERROR_CODES.WORKER_UNAVAILABLE)
    }
    const record = await this.pinStore.getByRequestId(id)
    if (record === null) throw new PinWorkerError('seed pin request not found', SEED_PIN_ERROR_CODES.NOT_FOUND)
    let allowed
    try {
      allowed = await runLifecycleOperation(
        this,
        Promise.resolve().then(() => this.releasePolicy(Object.freeze({
          requestId: id,
          action: state === 'cancelled' ? 'cancel' : 'release',
          options: clonePlainOptions(options),
          record,
        }))),
        this.releaseTimeout,
      )
    } catch (error) {
      if (error instanceof WorkerFault && error.reason === 'worker-stopped') {
        throw new PinWorkerError('seed pin worker stopped during release policy', SEED_PIN_ERROR_CODES.WORKER_UNAVAILABLE)
      }
      if (error instanceof WorkerFault && error.reason === 'release-policy-timeout') {
        throw new PinWorkerError('seed pin release policy timed out', SEED_PIN_ERROR_CODES.WORKER_UNAVAILABLE)
      }
      throw new PinWorkerError('seed pin release policy failed', SEED_PIN_ERROR_CODES.INTERNAL)
    }
    if (allowed !== true) {
      throw new PinWorkerError('seed pin release refused by policy', SEED_PIN_ERROR_CODES.POLICY_REJECTED)
    }

    const job = this.jobs.get(id) || null
    const updatedAt = this._now()
    const updated = await this.pinStore.updateWorkerStatus({
      requestId: id,
      state,
      refs: record.status.refs,
      errorCode: null,
      error: null,
      completedAt: null,
      downloadedBlocks: record.progress.downloadedBlocks,
      downloadedBytes: record.progress.downloadedBytes,
      updatedAt,
    })
    if (job) job.cancelled = true
    if (job) this._interrupt(job, new WorkerFault(state))
    const retention = this.retentions.get(id)
    if (retention) {
      await closeRetention(retention)
      this.retentions.delete(id)
    }
    if (job?.stage === 'queued') {
      const index = this.queue.indexOf(job)
      if (index !== -1) this.queue.splice(index, 1)
      this.jobs.delete(id)
      this._notifyCapacity()
      this._notifyIdle()
    }
    await this._releaseCapacityReservation(id)
    return updated
  }

  _throwIfInterrupted (job) {
    if (job.cancelled) throw new WorkerFault('cancelled')
    if (job.stopping || this.stopping) throw new WorkerFault('worker-stopped')
  }

  _interrupt (job, error) {
    for (const listener of [...job.abortListeners]) listener(error)
  }

  _now () {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError('now must return a nonnegative safe integer')
    }
    return value
  }

  _interruptLifecycle (error) {
    for (const listener of [...this.lifecycleListeners]) listener(error)
  }

  _notifyCapacity () {
    if (this.capacityWaiters.size === 0) return
    const waiters = [...this.capacityWaiters]
    this.capacityWaiters.clear()
    for (const waiter of waiters) waiter()
  }

  _notifyIdle () {
    if (this.active !== 0 || this.queue.length !== 0 || this.resumeTask !== null) return
    const error = this.resumeError
    for (const waiter of [...this.idleWaiters]) waiter(error)
  }
}

export function createPinWorker (options) {
  return new PinWorker(options)
}

function isBoundedActiveCursor (value) {
  return typeof value === 'string' && value.length > 0 && b4a.byteLength(value) <= 256
}

function boundedInteger (value, name, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${maximum}`)
  }
  return value
}

function normalizeRequestId (value) {
  if (typeof value !== 'string' || !HEX_32.test(value)) {
    throw new TypeError('requestId must be a lowercase 32-byte hex value')
  }
  return value
}

function normalizeCoreKey (value) {
  if (typeof value === 'string') return value.toLowerCase()
  if (value instanceof Uint8Array || b4a.isBuffer(value)) return b4a.toString(value, 'hex')
  throw new TypeError('opened core has no canonical key')
}

function countUniqueBlocks (refs) {
  let total = 0
  let currentCore = null
  let coveredEnd = -1
  for (const ref of refs) {
    if (ref.coreKey !== currentCore) {
      currentCore = ref.coreKey
      coveredEnd = -1
    }
    const uncoveredStart = Math.max(ref.start, coveredEnd)
    const count = Math.max(0, ref.end - uncoveredStart)
    if (!Number.isSafeInteger(count) || total > Number.MAX_SAFE_INTEGER - count) return null
    total += count
    coveredEnd = Math.max(coveredEnd, ref.end)
  }
  return total
}

function countTraversedBlocks (refs) {
  let total = 0
  for (const ref of refs) {
    const count = ref.end - ref.start
    if (!Number.isSafeInteger(count) || count < 0 ||
        total > Number.MAX_SAFE_INTEGER - count) return null
    total += count
  }
  return total
}

function coalesceRefs (refs) {
  const intervals = []
  for (const ref of refs) {
    const previous = intervals[intervals.length - 1]
    if (previous && previous.coreKey === ref.coreKey && ref.start <= previous.end) {
      previous.end = Math.max(previous.end, ref.end)
    } else {
      intervals.push({ coreKey: ref.coreKey, start: ref.start, end: ref.end })
    }
  }
  return intervals
}

function capacityFault () {
  return new WorkerFault('capacity', {
    state: 'failed',
    errorCode: SEED_PIN_ERROR_CODES.CAPACITY_EXCEEDED,
  })
}


function safeAdd (left, right, reason) {
  if (!Number.isSafeInteger(right) || right < 0 || left > Number.MAX_SAFE_INTEGER - right) {
    throw new WorkerFault(reason, {
      state: 'failed',
      errorCode: SEED_PIN_ERROR_CODES.CAPACITY_EXCEEDED,
    })
  }
  return left + right
}

function runJobOperation (job, promise, timeout, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      job.abortListeners.delete(onInterrupt)
      if (error) reject(error)
      else resolve(value)
    }
    const onInterrupt = error => finish(error)
    const timer = setTimeout(() => {
      let error
      try {
        error = onTimeout()
      } catch (caught) {
        error = caught
      }
      finish(error instanceof Error ? error : new WorkerFault('internal'))
    }, timeout)
    job.abortListeners.add(onInterrupt)
    Promise.resolve(promise).then(
      value => finish(null, value),
      error => finish(error),
    )
  })
}

function runLifecycleOperation (worker, promise, timeout) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.lifecycleListeners.delete(onInterrupt)
      if (error) reject(error)
      else resolve(value)
    }
    const onInterrupt = error => finish(error)
    const timer = setTimeout(
      () => finish(new WorkerFault('release-policy-timeout')),
      timeout,
    )
    worker.lifecycleListeners.add(onInterrupt)
    Promise.resolve(promise).then(
      value => finish(null, value),
      error => finish(error),
    )
  })
}

function runBoundedOperation (promise, timeout) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(
      () => finish(new WorkerFault('capacity-release-timeout')),
      timeout,
    )
    Promise.resolve(promise).then(
      value => finish(null, value),
      error => finish(error),
    )
  })
}

function interruptibleDelay (job, timeout) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      job.abortListeners.delete(onInterrupt)
      if (error) reject(error)
      else resolve()
    }
    const onInterrupt = error => finish(error)
    const timer = setTimeout(() => finish(null), timeout)
    job.abortListeners.add(onInterrupt)
  })
}

function destroyDownload (download) {
  try {
    if (typeof download.destroy === 'function') download.destroy()
    else if (typeof download.close === 'function') download.close()
  } catch {}
}

function destroyDownloads (retention) {
  if (retention.downloadsDestroyed) return
  retention.downloadsDestroyed = true
  for (const download of retention.downloads) destroyDownload(download)
}

async function closeRetention (retention) {
  if (retention.closed) return
  retention.closed = true
  destroyDownloads(retention)
  await retention.session.close().catch(() => {})
}

function markCurrentRefFailed (refs) {
  let marked = false
  return refs.map(ref => {
    if (!marked && ref.state !== 'complete') {
      marked = true
      return { ...ref, state: 'failed' }
    }
    return { ...ref }
  })
}

function cloneManifest (manifest) {
  return {
    version: manifest.version,
    channelKey: manifest.channelKey,
    rowId: manifest.rowId,
    refs: manifest.refs.map(ref => ({ ...ref })),
    assets: {
      media: [...manifest.assets.media],
      thumbnail: manifest.assets.thumbnail,
      artwork: { ...manifest.assets.artwork },
    },
    requestId: manifest.requestId,
  }
}

function clonePlainOptions (options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) return {}
  const clone = {}
  for (const [key, value] of Object.entries(options)) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isSafeInteger(value))) {
      clone[key] = value
    }
  }
  return clone
}

function createDeferred () {
  let resolvePromise
  let rejectPromise
  const deferred = {
    settled: false,
    promise: new Promise((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    }),
    resolve (value) {
      if (deferred.settled) return
      deferred.settled = true
      resolvePromise(value)
    },
    reject (error) {
      if (deferred.settled) return
      deferred.settled = true
      rejectPromise(error)
    },
  }
  return deferred
}

async function allow () {
  return true
}

async function deny () {
  return false
}

function noop () {}
