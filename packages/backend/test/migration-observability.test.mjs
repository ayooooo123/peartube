import test from 'brittle'

const domain = await import('../src/migrations/observability.js').catch(() => null)

function clone (value) {
  return value === undefined ? undefined : structuredClone(value)
}

function createStateStore (records = new Map()) {
  const writes = []
  return {
    records,
    writes,
    async get (key) {
      if (!records.has(key)) return null
      return { value: clone(records.get(key)) }
    },
    async put (key, value) {
      const next = clone(value)
      records.set(key, next)
      writes.push(next)
    }
  }
}

function createClock (start = 1_000) {
  let current = start
  return () => current++
}

function deferred () {
  let resolve
  let reject
  const promise = new Promise((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

test('migration lifecycle persists pending, running, checkpoint, and complete transitions', async (t) => {
  t.ok(domain, 'migration observability module exists')
  if (!domain) return

  const store = createStateStore()
  const started = deferred()
  const finished = deferred()
  const lifecycle = domain.createMigrationLifecycle({
    store,
    now: createClock(),
    migrations: {
      'publication-v1': async ({ persistCheckpoint }) => {
        await persistCheckpoint({
          checkpoint: { completedLegacySourceIds: ['legacy-1'] },
          processedCount: 1,
          importedCount: 1,
          remainingCount: 1
        })
        started.resolve()
        return finished.promise
      }
    }
  })

  const initial = await domain.getMigrationStatus(lifecycle, { migrationId: 'publication-v1' })
  t.alike(initial, {
    success: true,
    migrationId: 'publication-v1',
    state: 'pending',
    version: 1,
    processedCount: 0,
    importedCount: 0,
    skippedCount: 0,
    quarantinedCount: 0,
    unsupportedCount: 0,
    remainingCount: 0,
    retryable: true,
    updatedAt: 1000,
    reportDigest: initial.reportDigest
  })
  t.is(initial.reportDigest.length, 64)

  const retry = domain.retryMigration(lifecycle, { migrationId: 'publication-v1' })
  await started.promise
  const running = await domain.getMigrationStatus(lifecycle, { migrationId: 'publication-v1' })
  t.is(running.state, 'running')
  t.is(running.processedCount, 1)
  t.is(running.remainingCount, 1)

  finished.resolve({
    state: 'complete',
    checkpoint: { completedLegacySourceIds: ['legacy-1', 'legacy-2'] },
    processedCount: 2,
    importedCount: 2,
    remainingCount: 0
  })
  const completed = await retry
  t.is(completed.state, 'complete')
  t.is(completed.joined, false)
  t.is(completed.processedCount, 2)
  t.is(completed.importedCount, 2)
  t.is(completed.retryable, false)
  t.alike(Array.from(new Set(store.writes.map(entry => entry.state))).sort(), ['complete', 'pending', 'running'])
})

test('failed checkpoints survive restart and resume through retrying without exporting secrets', async (t) => {
  t.ok(domain, 'migration observability module exists')
  if (!domain) return

  const store = createStateStore()
  const rootSecret = 'ab'.repeat(64)
  const privateSecret = 'private-root-material-never-export'
  const first = domain.createMigrationLifecycle({
    store,
    now: createClock(2_000),
    migrations: {
      'legacy-publisher-root': async ({ persistCheckpoint }) => {
        await persistCheckpoint({
          checkpoint: { cursor: 1, privateKey: privateSecret, rootKey: rootSecret },
          processedCount: 1,
          importedCount: 0,
          remainingCount: 1
        })
        throw Object.assign(new Error(`denied secret=${privateSecret}`), { code: 'SOURCE_LOCKED' })
      }
    }
  })

  const failed = await domain.retryMigration(first, { migrationId: 'legacy-publisher-root' })
  t.is(failed.state, 'failed')
  t.is(failed.errorCode, 'SOURCE_LOCKED')
  t.is(failed.errorMessage, 'Migration failed')
  t.absent(JSON.stringify(failed).includes(privateSecret))

  const failedReport = await domain.exportMigrationReport(first, { migrationId: 'legacy-publisher-root' })
  const failedText = Buffer.from(failedReport.reportBytes).toString()
  t.absent(failedText.includes(privateSecret))
  t.absent(failedText.includes(rootSecret))
  t.absent(failedText.includes('privateKey'))
  t.absent(failedText.includes('rootKey'))

  const resumed = deferred()
  const observedCheckpoint = deferred()
  const second = domain.createMigrationLifecycle({
    store,
    now: createClock(3_000),
    migrations: {
      'legacy-publisher-root': async ({ checkpoint }) => {
        observedCheckpoint.resolve(checkpoint)
        return resumed.promise
      }
    }
  })

  const persisted = await domain.getMigrationStatus(second, { migrationId: 'legacy-publisher-root' })
  t.is(persisted.state, 'failed')
  t.is(persisted.errorCode, 'SOURCE_LOCKED')

  const retry = domain.retryMigration(second, { migrationId: 'legacy-publisher-root' })
  const checkpoint = await observedCheckpoint.promise
  t.is(checkpoint.privateKey, privateSecret, 'checkpoint is retained for the local adapter')
  t.is(checkpoint.rootKey, rootSecret, 'source material is not discarded before durable completion')
  const retrying = await domain.getMigrationStatus(second, { migrationId: 'legacy-publisher-root' })
  t.is(retrying.state, 'retrying')

  resumed.resolve({
    state: 'complete',
    checkpoint: { cursor: 2 },
    processedCount: 2,
    importedCount: 1,
    remainingCount: 0
  })
  const complete = await retry
  t.is(complete.state, 'complete')
  t.is(complete.errorCode, undefined)
})

test('concurrent retries join one adapter execution per migration', async (t) => {
  t.ok(domain, 'migration observability module exists')
  if (!domain) return

  const store = createStateStore()
  const started = deferred()
  const finished = deferred()
  let executions = 0
  const lifecycle = domain.createMigrationLifecycle({
    store,
    now: createClock(4_000),
    migrations: {
      'publication-v1': async () => {
        executions++
        started.resolve()
        return finished.promise
      }
    }
  })

  const owner = domain.retryMigration(lifecycle, { migrationId: 'publication-v1' })
  await started.promise
  const joiner = domain.retryMigration(lifecycle, { migrationId: 'publication-v1' })
  finished.resolve({ state: 'complete', processedCount: 1, importedCount: 1 })

  const [ownerResult, joinedResult] = await Promise.all([owner, joiner])
  t.is(executions, 1)
  t.is(ownerResult.joined, false)
  t.is(joinedResult.joined, true)
  t.is(ownerResult.reportDigest, joinedResult.reportDigest)
})

test('quarantine and unsupported failures are stable, bounded, attributed only by digest', async (t) => {
  t.ok(domain, 'migration observability module exists')
  if (!domain) return

  const store = createStateStore()
  const rawSubjects = Array.from({ length: 48 }, (_, index) => `private-source-${index}`)
  const lifecycle = domain.createMigrationLifecycle({
    store,
    now: createClock(5_000),
    migrations: {
      'publication-v1': async () => ({
        state: 'complete',
        processedCount: 7,
        importedCount: 2,
        skippedCount: 1,
        quarantinedCount: 2,
        unsupportedCount: 2,
        failures: rawSubjects.map((subject, index) => ({
          code: index % 2 === 0 ? 'LEGACY_RECORD_QUARANTINED' : 'LEGACY_SHAPE_UNSUPPORTED',
          category: index % 2 === 0 ? 'quarantined' : 'unsupported',
          subject
        }))
      })
    }
  })

  const complete = await domain.retryMigration(lifecycle, { migrationId: 'publication-v1' })
  t.is(complete.processedCount, 7)
  t.is(complete.importedCount, 2)
  t.is(complete.skippedCount, 1)
  t.is(complete.quarantinedCount, 2)
  t.is(complete.unsupportedCount, 2)

  const first = await domain.exportMigrationReport(lifecycle, { migrationId: 'publication-v1' })
  const second = await domain.exportMigrationReport(lifecycle, { migrationId: 'publication-v1' })
  t.alike(Buffer.from(second.reportBytes), Buffer.from(first.reportBytes))
  t.is(second.reportDigest, first.reportDigest)

  const body = JSON.parse(Buffer.from(first.reportBytes).toString())
  t.is(body.failures.length, domain.MIGRATION_LIMITS.maxFailureEntries)
  t.ok(body.failures.every(failure => /^[0-9a-f]{64}$/.test(failure.subjectHash)))
  t.ok(body.failures.some(failure => failure.code === 'LEGACY_RECORD_QUARANTINED'))
  t.ok(body.failures.some(failure => failure.code === 'LEGACY_SHAPE_UNSUPPORTED'))
  for (const subject of rawSubjects) t.absent(Buffer.from(first.reportBytes).includes(Buffer.from(subject)))
})

test('canonical report export enforces its byte bound and adapters return stable unknown-id failures', async (t) => {
  t.ok(domain, 'migration observability module exists')
  if (!domain) return

  const store = createStateStore()
  const lifecycle = domain.createMigrationLifecycle({
    store,
    now: createClock(6_000),
    maxReportBytes: 900,
    migrations: {
      'legacy-publisher-root': async () => ({
        state: 'failed',
        errorCode: 'LEGACY_ROOT_DENIED',
        failures: Array.from({ length: 32 }, (_, index) => ({
          code: `LEGACY_ROOT_FAILURE_${String(index).padStart(2, '0')}`,
          category: 'quarantined',
          subject: `root-${index}`
        }))
      })
    }
  })

  await domain.retryMigration(lifecycle, { migrationId: 'legacy-publisher-root' })
  const report = await domain.exportMigrationReport(lifecycle, { migrationId: 'legacy-publisher-root' })
  t.is(report.success, true)
  t.ok(report.reportBytes.byteLength <= 900)
  t.is(report.reportDigest.length, 64)
  const decoded = JSON.parse(Buffer.from(report.reportBytes).toString())
  t.is(decoded.failuresTruncated, true)
  t.alike(decoded, JSON.parse(JSON.stringify(decoded)), 'report is plain canonical JSON')

  const missingStatus = await domain.getMigrationStatus(lifecycle, { migrationId: 'missing' })
  const missingRetry = await domain.retryMigration(lifecycle, { migrationId: 'missing' })
  const missingReport = await domain.exportMigrationReport(lifecycle, { migrationId: 'missing' })
  t.alike(missingStatus, {
    success: false,
    migrationId: 'missing',
    state: 'failed',
    version: 1,
    processedCount: 0,
    importedCount: 0,
    skippedCount: 0,
    quarantinedCount: 0,
    unsupportedCount: 0,
    remainingCount: 0,
    retryable: false,
    updatedAt: 0,
    errorCode: 'MIGRATION_NOT_FOUND',
    errorMessage: 'Migration not found'
  })
  t.alike(missingRetry, { ...missingStatus, joined: false })
  t.alike(missingReport, { success: false, migrationId: 'missing', errorCode: 'MIGRATION_NOT_FOUND' })
})
